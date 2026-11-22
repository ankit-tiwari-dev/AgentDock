// Lighthouse against every dashboard page, served by the real backend on a throwaway seeded project.
// Usage: node scripts/page-check.ts [--check]   (needs `npm run build` first, and Chrome or Chromium installed)
// Measures LCP, CLS and accessibility audits of serious or critical impact (Lighthouse runs axe-core). With --check
// it compares the worst page with the "Page LCP", "Page CLS" and "Accessibility" rows in CONSTRAINTS.md.
// Exit 0 pass, 1 over a budget, 2 could not run.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const PAGES = ["overview", "waiting", "sessions", "rules", "plan", "project", "settings"];
export const ROWS = { lcp: "Page LCP", cls: "Page CLS", a11y: "Accessibility" } as const;

const ROOT = join(import.meta.dirname, "..");
const LIGHTHOUSE = join(ROOT, "node_modules", "lighthouse", "cli", "index.js");
const BLOCKING_IMPACT = new Set(["serious", "critical"]);

export interface PageResult {
  page: string;
  lcpMs: number;
  cls: number;
  a11y: string[];
}

interface LighthouseReport {
  runtimeError?: { code: string; message: string };
  audits: Record<
    string,
    { score: number | null; numericValue?: number; details?: { debugData?: { impact?: string } } }
  >;
  categories: { accessibility?: { auditRefs: Array<{ id: string }> } };
}

/** The numbers this gate reads from one Lighthouse JSON report; throws on a report that did not finish. */
export function readReport(page: string, report: LighthouseReport): PageResult {
  if (report.runtimeError) throw new Error(`${page}: Lighthouse ${report.runtimeError.code}`);
  const lcp = report.audits["largest-contentful-paint"]?.numericValue;
  const cls = report.audits["cumulative-layout-shift"]?.numericValue;
  const refs = report.categories.accessibility?.auditRefs;
  if (typeof lcp !== "number" || typeof cls !== "number" || !refs)
    throw new Error(`${page}: incomplete Lighthouse report`);
  const a11y = refs
    .map((r) => ({ id: r.id, audit: report.audits[r.id] }))
    .filter(({ audit }) => audit?.score === 0 && BLOCKING_IMPACT.has(audit.details?.debugData?.impact ?? ""))
    .map(({ id }) => id);
  return { page, lcpMs: lcp, cls, a11y };
}

/** The number after "at most" on the CONSTRAINTS.md table row whose first cell is `label`. */
export function readAtMost(constraints: string, label: string): number | null {
  for (const line of constraints.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    if (cells[1] !== label) continue;
    const m = /at most\s+(\d+(?:\.\d+)?)/i.exec(cells.slice(2).join(" "));
    if (m) return Number(m[1]);
  }
  return null;
}

export function judge(results: PageResult[], budget: { lcp: number; cls: number; a11y: number }): string[] {
  const failures: string[] = [];
  for (const r of results) {
    if (r.lcpMs > budget.lcp) failures.push(`${r.page}: LCP ${r.lcpMs.toFixed(0)} ms, budget ${budget.lcp} ms`);
    if (r.cls > budget.cls) failures.push(`${r.page}: CLS ${r.cls.toFixed(3)}, budget ${budget.cls}`);
    if (r.a11y.length > budget.a11y)
      failures.push(
        `${r.page}: ${r.a11y.length} serious/critical a11y audits (${r.a11y.join(", ")}), budget ${budget.a11y}`,
      );
  }
  return failures;
}

function seed(dir: string): void {
  mkdirSync(join(dir, ".ctrlplane"));
  const db = new DatabaseSync(join(dir, ".ctrlplane", "audit.db"));
  try {
    db.exec(readFileSync(join(ROOT, "backend", "tests", "fixtures", "cli-schema.sql"), "utf8"));
    const now = Date.now();
    const tools = ["Bash", "Read", "Edit", "Write", "Grep"];
    const verdicts = ["ALLOW", "ALLOW", "ALLOW", "DENY", "REQUIRE_MANUAL_APPROVAL", "INSTRUCT"];
    const session = db.prepare(
      "INSERT INTO sessions (id, agent_type, project_path, git_branch, base_commit_sha, status, started_at) VALUES (?, ?, ?, 'main', 'abc', ?, ?)",
    );
    const usage = db.prepare(
      "INSERT INTO session_usage VALUES (?, 'claude-sonnet-4-5', 12000, 3000, 50000, 1000, 0.123, 0, 14, ?)",
    );
    const event = db.prepare("INSERT INTO events VALUES (?, ?, ?, 'pre_tool', ?, ?, NULL, 0, ?, ?, 3, ?, ?)");
    for (let s = 0; s < 8; s++) {
      const id = `ses_${s}`;
      session.run(id, s % 2 ? "codex" : "claude-code", dir, s === 0 ? "active" : "completed", now - s * 3_600_000);
      usage.run(id, now);
      for (let i = 0; i < 40; i++) {
        const verdict = verdicts[(s + i) % verdicts.length];
        const tool = tools[i % tools.length];
        event.run(
          `evt_${s}_${i}`,
          id,
          i,
          tool,
          JSON.stringify({ command: `npm test -- part ${i}` }),
          verdict,
          verdict === "ALLOW" ? null : `rule matched on call ${i}`,
          now - s * 3_600_000 - (40 - i) * 20_000,
          verdict === "ALLOW" ? null : `RULE-${tool.toUpperCase()}`,
        );
      }
    }
  } finally {
    db.close();
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")),
      );
    });
  });
}

async function waitForHealth(port: number, child: ChildProcess): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`backend exited with ${child.exitCode}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("backend did not answer /api/health within 20 s");
}

/** Runs Lighthouse on one URL, writing its JSON report to `out`; returns the exit status and stderr. */
export type LighthouseRunner = (
  url: string,
  out: string,
) => { status: number | null; stderr: string } | Promise<{ status: number | null; stderr: string }>;

const runLighthouse: LighthouseRunner = (url, out) =>
  spawnSync(
    process.execPath,
    [
      LIGHTHOUSE,
      url,
      "--output=json",
      `--output-path=${out}`,
      "--quiet",
      "--preset=desktop",
      "--only-categories=performance,accessibility",
      "--chrome-flags=--headless=new --no-sandbox",
    ],
    { encoding: "utf8" },
  );

export async function measurePages(lighthouse: LighthouseRunner = runLighthouse): Promise<PageResult[]> {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-pages-"));
  let backend: ChildProcess | undefined;
  try {
    seed(dir);
    const port = await freePort();
    backend = spawn(process.execPath, [join(ROOT, "backend", "src", "server.ts"), "--project", dir], {
      env: { ...process.env, AGENTDOCK_PORT: String(port), CTRLPLANE_HOME: join(dir, "home"), AGENTDOCK_CODEX: "" },
      cwd: ROOT,
      stdio: "ignore",
    });
    await waitForHealth(port, backend);
    const results: PageResult[] = [];
    for (const page of PAGES) {
      const out = join(dir, `${page}.json`);
      const r = await lighthouse(`http://127.0.0.1:${port}/#${page}`, out);
      if (r.status !== 0 || !existsSync(out))
        throw new Error(`${page}: lighthouse exited ${String(r.status)}: ${(r.stderr ?? "").slice(-300)}`);
      results.push(readReport(page, JSON.parse(readFileSync(out, "utf8")) as LighthouseReport));
    }
    return results;
  } finally {
    // Windows keeps the folder open until the backend has really exited.
    if (backend && backend.exitCode === null) {
      const exited = new Promise((resolve) => backend?.once("exit", resolve));
      backend.kill();
      await exited;
    }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

async function measureBuiltPages(): Promise<PageResult[]> {
  if (!existsSync(join(ROOT, "frontend", "out", "index.html"))) {
    throw new Error("frontend/out is missing: run npm run build first");
  }
  return measurePages();
}

/** `measure` is a parameter so the threshold logic can be tested without starting the backend for each case. */
export async function main(argv: string[], measure: () => Promise<PageResult[]> = measureBuiltPages): Promise<number> {
  let results: PageResult[];
  try {
    results = await measure();
  } catch (error) {
    console.error("page-check: " + (error instanceof Error ? error.message : String(error)));
    return 2;
  }
  for (const r of results) {
    console.log(
      `page-check: ${r.page.padEnd(9)} LCP ${r.lcpMs.toFixed(0)} ms  CLS ${r.cls.toFixed(3)}  a11y serious/critical ${r.a11y.length}${r.a11y.length ? " (" + r.a11y.join(", ") + ")" : ""}`,
    );
  }
  if (!argv.includes("--check")) return 0;
  const constraints = existsSync("CONSTRAINTS.md") ? readFileSync("CONSTRAINTS.md", "utf8") : "";
  const budget = {
    lcp: readAtMost(constraints, ROWS.lcp),
    cls: readAtMost(constraints, ROWS.cls),
    a11y: readAtMost(constraints, ROWS.a11y),
  };
  if (budget.lcp === null || budget.cls === null || budget.a11y === null) {
    console.error(
      `page-check: CONSTRAINTS.md needs "${ROWS.lcp}", "${ROWS.cls}" and "${ROWS.a11y}" rows with an "at most <n>" value`,
    );
    return 2;
  }
  const failures = judge(results, { lcp: budget.lcp, cls: budget.cls, a11y: budget.a11y });
  for (const f of failures) console.error("  " + f);
  return failures.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = await main(process.argv.slice(2));
