import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PAGES, judge, main, measurePages, readAtMost, readReport, type LighthouseRunner } from "../page-check.ts";

function fakeLighthouse(lcp: number, seen: string[] = []): LighthouseRunner {
  return (url, out) => {
    seen.push(url);
    writeFileSync(
      out,
      JSON.stringify({
        audits: {
          "largest-contentful-paint": { score: 1, numericValue: lcp },
          "cumulative-layout-shift": { score: 1, numericValue: 0.01 },
        },
        categories: { accessibility: { auditRefs: [] } },
      }),
    );
    return { status: 0, stderr: "" };
  };
}

test("measurePages starts the real backend on a seeded throwaway project and audits every page", async () => {
  const seen: string[] = [];
  const results = await measurePages(async (url, out) => {
    const health = await fetch(new URL("/api/health", url));
    assert.equal(health.status, 200);
    return fakeLighthouse(800, seen)(url, out);
  });
  assert.deepEqual(
    results.map((r) => r.page),
    PAGES,
  );
  assert.deepEqual(
    seen.map((u) => new URL(u).hash),
    PAGES.map((p) => `#${p}`),
  );
});

test("measurePages fails, and stops the backend, when Lighthouse fails", async () => {
  await assert.rejects(
    measurePages(() => ({ status: 1, stderr: "no chrome" })),
    /lighthouse exited 1: no chrome/,
  );
});

test("main --check compares the worst page with CONSTRAINTS.md and fails a broken run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "page-check-"));
  const cwd = process.cwd();
  // Fixed results: the backend start-up is covered by the measurePages tests above, once each.
  const pages = (lcpMs: number) => () => Promise.resolve(PAGES.map((page) => ({ page, lcpMs, cls: 0.01, a11y: [] })));
  try {
    process.chdir(dir);
    assert.equal(await main(["--check"], pages(800)), 2, "no CONSTRAINTS.md rows");
    writeFileSync(
      join(dir, "CONSTRAINTS.md"),
      "| Page LCP | at most 1000 ms | x |\n| Page CLS | at most 0.1 | x |\n| Accessibility | at most 0 | x |\n",
    );
    assert.equal(await main(["--check"], pages(800)), 0);
    assert.equal(await main(["--check"], pages(1200)), 1);
    assert.equal(await main([], () => Promise.reject(new Error("lighthouse exited 1: no chrome"))), 2);
    assert.ok(readFileSync(join(dir, "CONSTRAINTS.md"), "utf8").includes("Page LCP"));
  } finally {
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

function report(overrides: Record<string, unknown> = {}) {
  return {
    audits: {
      "largest-contentful-paint": { score: 1, numericValue: 900 },
      "cumulative-layout-shift": { score: 1, numericValue: 0.05 },
      "color-contrast": { score: 0, details: { debugData: { impact: "serious" } } },
      "image-alt": { score: 0, details: { debugData: { impact: "minor" } } },
      "button-name": { score: 1, details: { debugData: { impact: "critical" } } },
    },
    categories: {
      accessibility: { auditRefs: [{ id: "color-contrast" }, { id: "image-alt" }, { id: "button-name" }] },
    },
    ...overrides,
  };
}

test("readReport counts only failing accessibility audits of serious or critical impact", () => {
  const r = readReport("overview", report());
  assert.equal(r.lcpMs, 900);
  assert.equal(r.cls, 0.05);
  assert.deepEqual(r.a11y, ["color-contrast"]);
});

test("readReport refuses a report that did not finish, so a broken run never reads as clean", () => {
  assert.throws(
    () => readReport("overview", { ...report(), runtimeError: { code: "NO_FCP", message: "x" } }),
    /NO_FCP/,
  );
  assert.throws(() => readReport("overview", { audits: {}, categories: {} }), /incomplete/);
});

test("readAtMost reads the number after 'at most' on the named row", () => {
  const md = "| Page LCP | at most 1600 ms on every page | x |\n| Page CLS | at most 0.2 | x |";
  assert.equal(readAtMost(md, "Page LCP"), 1600);
  assert.equal(readAtMost(md, "Page CLS"), 0.2);
  assert.equal(readAtMost(md, "Accessibility"), null);
});

test("judge reports each page over a budget", () => {
  const results = [
    { page: "overview", lcpMs: 1700, cls: 0.05, a11y: [] },
    { page: "rules", lcpMs: 900, cls: 0.25, a11y: ["a", "b"] },
  ];
  assert.equal(judge(results, { lcp: 1600, cls: 0.2, a11y: 1 }).length, 3);
  assert.equal(judge(results, { lcp: 2000, cls: 0.3, a11y: 2 }).length, 0);
});
