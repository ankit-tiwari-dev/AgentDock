import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentDockBackendServer } from "../src/server.ts";
import { createAuditDb, type AuditDb } from "./live-view-fixture.ts";

type Listed = { projects: { id: string; projectPath: string }[] };

async function withServer(dirs: string[], run: (base: string, ids: string[], port: number) => Promise<void>) {
  const server = new AgentDockBackendServer({ port: 0, projectPaths: dirs });
  const { port } = await server.start();
  try {
    const base = `http://127.0.0.1:${port}`;
    const listed = (await (await fetch(`${base}/api/projects`)).json()) as Listed;
    await run(
      base,
      listed.projects.map((p) => p.id),
      port,
    );
  } finally {
    await server.stop();
  }
}

function send(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(method === "GET" ? undefined : "{}");
  });
}

function twoProjects(): [AuditDb, AuditDb] {
  const a = createAuditDb();
  const b = createAuditDb();
  a.seedSession("sa");
  a.seedEvent("sa", { toolInput: { command: "grep needle-alpha src" } });
  a.seedEvents("sa", 599);
  b.seedSession("sb");
  b.seedEvents("sb", 3);
  return [a, b];
}

test("search over 600 events through the route finds the old event that the snapshot does not hold", async () => {
  const [a, b] = twoProjects();
  try {
    await withServer([a.dir, b.dir], async (base, [ida]) => {
      const state = (await (await fetch(`${base}/api/dashboard/state?project=${ida}`)).json()) as {
        events: { toolInput?: { command?: string } }[];
      };
      assert.ok(!state.events.some((e) => e.toolInput?.command?.includes("needle-alpha")));
      const res = await fetch(`${base}/api/events/search?project=${ida}&q=needle-alpha`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { events: { sequenceNum: number; sessionId: string }[]; nextBefore: unknown };
      assert.deepEqual(
        body.events.map((e) => [e.sessionId, e.sequenceNum]),
        [["sa", 1]],
      );
      assert.equal(body.nextBefore, null);

      const timeline = await fetch(`${base}/api/sessions/sa/timeline?project=${ida}&after=0&limit=2`);
      assert.equal(timeline.status, 200);
      const page = (await timeline.json()) as { events: { sequenceNum: number }[]; nextAfter: unknown };
      assert.deepEqual(
        page.events.map((e) => e.sequenceNum),
        [1, 2],
      );
      assert.ok(page.nextAfter);
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a bad query value gives 400 QUERY_INVALID with fixed text", async () => {
  const [a, b] = twoProjects();
  try {
    await withServer([a.dir, b.dir], async (base, [ida]) => {
      const res = await fetch(`${base}/api/events/search?project=${ida}&q=x`);
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: "Search text must be 2 to 200 characters.", code: "QUERY_INVALID" });
      const t = await fetch(`${base}/api/sessions/sa/timeline?project=${ida}&limit=999`);
      assert.equal(t.status, 400);
      assert.equal(((await t.json()) as { code: string }).code, "QUERY_INVALID");
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("an unknown project gives 404, and a timeline for a session of the other project gives 404", async () => {
  const [a, b] = twoProjects();
  try {
    await withServer([a.dir, b.dir], async (base, [ida, idb]) => {
      assert.equal((await fetch(`${base}/api/events/search?project=nope&q=ab`)).status, 404);
      assert.equal((await fetch(`${base}/api/sessions/sa/timeline?project=nope`)).status, 404);
      const cross = await fetch(`${base}/api/sessions/sb/timeline?project=${ida}`);
      assert.equal(cross.status, 404);
      assert.deepEqual(await cross.json(), { error: "Unknown session for this project.", code: "SESSION_NOT_FOUND" });
      assert.equal((await fetch(`${base}/api/sessions/sb/timeline?project=${idb}`)).status, 200);
      const weird = await fetch(`${base}/api/sessions/${encodeURIComponent("a\u0001b")}/timeline?project=${ida}`);
      assert.equal(weird.status, 404);
      assert.equal((await fetch(`${base}/api/sessions/%E0%A4%A/timeline?project=${ida}`)).status, 404);
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a bad Host header is refused as today, and POST, PUT and DELETE on the new paths are not served", async () => {
  const [a, b] = twoProjects();
  try {
    await withServer([a.dir, b.dir], async (base, [ida], port) => {
      assert.equal(
        await send(port, "GET", `/api/events/search?project=${ida}&q=ab`, { Host: `evil.example:${port}` }),
        403,
      );
      for (const method of ["POST", "PUT", "DELETE"]) {
        for (const path of [`/api/events/search?project=${ida}&q=ab`, `/api/sessions/sa/timeline?project=${ida}`]) {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          assert.equal(res.status, 404, `${method} ${path}`);
        }
      }
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("the audit.db bytes are unchanged after the run", async () => {
  const [a, b] = twoProjects();
  try {
    a.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
    a.db.close();
    const before = readFileSync(a.dbPath);
    await withServer([a.dir, b.dir], async (base, [ida]) => {
      await fetch(`${base}/api/dashboard/state?project=${ida}`);
      await fetch(`${base}/api/events/search?project=${ida}&q=needle`);
      await fetch(`${base}/api/sessions/sa/timeline?project=${ida}`);
    });
    assert.ok(readFileSync(a.dbPath).equals(before));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("a database read error gives 503 without SQL text, and the log holds only the route and the error code", async (t) => {
  const a = createAuditDb();
  try {
    a.db.close();
    // A file that opens as SQLite but has none of the CLI's tables.
    writeFileSync(a.dbPath, "");
    const broken = new DatabaseSync(a.dbPath);
    broken.exec("CREATE TABLE unrelated (x);");
    broken.close();
    const logs: string[] = [];
    t.mock.method(console, "error", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
    t.mock.method(console, "log", (...args: unknown[]) => logs.push(args.map(String).join(" ")));
    await withServer([a.dir], async (base, [id]) => {
      for (const path of [
        `/api/events/search?project=${id}&q=secret-term`,
        `/api/sessions/s1/timeline?project=${id}`,
      ]) {
        const res = await fetch(`${base}${path}`);
        assert.equal(res.status, 503, path);
        const text = await res.text();
        assert.deepEqual(JSON.parse(text), {
          error: "The audit database could not be read. Try again.",
          code: "DB_UNAVAILABLE",
        });
      }
    });
    const joined = logs.join("\n");
    assert.ok(joined.includes("code=ERR_SQLITE_ERROR"), joined);
    assert.ok(!/select|from events|no such table/i.test(joined), joined);
    assert.ok(!joined.includes("secret-term"), joined);
  } finally {
    a.cleanup();
  }
});

test("regression: the search text is never written to the backend log", async (t) => {
  const [a, b] = twoProjects();
  const planted = "planted-search-term-7c1";
  const logs: string[] = [];
  try {
    for (const name of ["log", "info", "warn", "error", "debug"] as const) {
      t.mock.method(console, name, (...args: unknown[]) => logs.push(args.map(String).join(" ")));
    }
    await withServer([a.dir, b.dir], async (base, [ida]) => {
      await fetch(`${base}/api/events/search?project=${ida}&q=${planted}&tool=${planted}`);
      await fetch(`${base}/api/events/search?project=${ida}&q=${planted}${"x".repeat(300)}`);
      await fetch(`${base}/api/events/search?project=nope&q=${planted}`);
    });
    assert.ok(!logs.join("\n").includes(planted));
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("no backend source file reads the home folder or a .claude path", () => {
  const dir = join(import.meta.dirname, "..", "src");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const text = readFileSync(join(dir, file), "utf8");
    assert.ok(!text.includes('".claude"') && !text.includes("'.claude'"), `${file} names .claude`);
    // The supervisor settings live in $CTRLPLANE_HOME, which defaults to ~/.ctrlplane.
    if (["provider-resolver.ts", "supervisor-config.ts"].includes(file)) continue;
    assert.ok(!text.includes("homedir("), `${file} reads the home folder`);
  }
});
