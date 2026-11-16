import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectIds } from "../src/projects.ts";
import { AgentDockBackendServer } from "../src/server.ts";

function auditProject(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(dir, ".ctrlplane"));
  const db = new DatabaseSync(join(dir, ".ctrlplane", "audit.db"));
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, project_path TEXT NOT NULL,
      git_branch TEXT NOT NULL, base_commit_sha TEXT NOT NULL, head_commit_sha TEXT, spec_id TEXT, status TEXT NOT NULL,
      started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT);
    CREATE TABLE events (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, sequence_num INTEGER NOT NULL,
      event_type TEXT NOT NULL, tool_name TEXT, tool_input_json TEXT, tool_output_json TEXT,
      is_blob_stored INTEGER NOT NULL DEFAULT 0, policy_verdict TEXT, policy_reason TEXT, execution_duration_ms INTEGER,
      created_at INTEGER NOT NULL);`);
  db.prepare(
    "INSERT INTO sessions VALUES ('s1', 'claude-code', ?, 'main', 'abc', NULL, NULL, 'active', ?, NULL, NULL)",
  ).run(dir, Date.now());
  let seq = 0;
  const addEvent = (command: string, verdict = "ALLOW") =>
    db
      .prepare(
        "INSERT INTO events (id, session_id, sequence_num, event_type, tool_name, tool_input_json, policy_verdict, created_at) VALUES (?, 's1', ?, 'pre_tool', 'Bash', ?, ?, ?)",
      )
      .run(`evt_${++seq}`, seq, JSON.stringify({ command }), verdict, Date.now());
  return { dir, addEvent, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

type Listed = { projects: { id: string; name: string; projectPath: string; available: boolean }[] };
type State = { source: { projectPath: string }; events: { toolInput?: { command?: string } }[] };

async function withServer(
  config: ConstructorParameters<typeof AgentDockBackendServer>[0],
  run: (base: string, server: AgentDockBackendServer) => Promise<void>,
) {
  const server = new AgentDockBackendServer({ port: 0, ...config });
  const { port } = await server.start();
  try {
    await run(`http://127.0.0.1:${port}`, server);
  } finally {
    await server.stop();
  }
}

test("project ids come from folder names, one per folder, numbered when names repeat", () => {
  const listed = projectIds(["/work/AgentDock", "/work/AgentDock/", "/other/agentdock", "/work/My App"]);
  assert.deepEqual(
    listed.map((p) => p.id),
    ["agentdock", "agentdock-2", "my-app"],
  );
  assert.deepEqual(
    listed.map((p) => p.name),
    ["AgentDock", "agentdock", "My App"],
  );
  if (process.platform === "win32") {
    assert.equal(projectIds(["C:\\Work\\Repo", "c:\\work\\repo"]).length, 1, "Windows paths ignore case");
  }
});

test("GET /api/projects lists every --project in order, and says which have an audit log", async () => {
  const a = auditProject("agentdock-mp-a-");
  const empty = mkdtempSync(join(tmpdir(), "agentdock-mp-empty-"));
  try {
    await withServer({ projectPaths: [a.dir, empty] }, async (base) => {
      const res = await fetch(`${base}/api/projects`);
      assert.equal(res.status, 200);
      const { projects } = (await res.json()) as Listed;
      assert.deepEqual(
        projects.map((p) => [p.name, p.available]),
        [
          [basename(a.dir), true],
          [basename(empty), false],
        ],
      );
      assert.equal(projects[0].projectPath, a.dir);
    });
  } finally {
    a.cleanup();
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the state of a named project holds only its events; no project means the first one", async () => {
  const a = auditProject("agentdock-mp-a-");
  const b = auditProject("agentdock-mp-b-");
  a.addEvent("echo from-a");
  b.addEvent("echo from-b");
  try {
    await withServer({ projectPaths: [a.dir, b.dir] }, async (base) => {
      const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as Listed;
      const stateOf = async (query: string) =>
        (await (await fetch(`${base}/api/dashboard/state${query}`)).json()) as State;
      const forB = await stateOf(`?project=${projects[1].id}`);
      assert.equal(forB.source.projectPath, b.dir);
      assert.deepEqual(
        forB.events.map((e) => e.toolInput?.command),
        ["echo from-b"],
      );
      assert.equal((await stateOf("")).source.projectPath, a.dir);
    });
  } finally {
    a.cleanup();
    b.cleanup();
  }
});

test("security: a project the backend did not list, or a path, is refused with 404 on every route", async () => {
  const a = auditProject("agentdock-mp-a-");
  try {
    await withServer({ projectPaths: [a.dir] }, async (base) => {
      for (const project of ["nope", "..", encodeURIComponent(a.dir), "%2E%2E%2F"]) {
        const state = await fetch(`${base}/api/dashboard/state?project=${project}`);
        assert.equal(state.status, 404, `state ?project=${project}`);
        assert.deepEqual(await state.json(), { error: "Unknown project" });
        for (const path of ["/api/supervisor/interview", "/api/reviewer/explain"]) {
          const post = await fetch(`${base}${path}?project=${project}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ featurePrompt: "Add a flag" }),
          });
          assert.equal(post.status, 404, `${path} ?project=${project}`);
        }
      }
    });
  } finally {
    a.cleanup();
  }
});

test("every streamed event names its project, and a broken audit log does not stop the others", async () => {
  const broken = mkdtempSync(join(tmpdir(), "agentdock-mp-broken-"));
  mkdirSync(join(broken, ".ctrlplane"));
  writeFileSync(join(broken, ".ctrlplane", "audit.db"), "this is not a database");
  const b = auditProject("agentdock-mp-b-");
  try {
    await withServer({ projectPaths: [broken, b.dir] }, async (base, server) => {
      const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as Listed;
      assert.equal(projects[0].available, false, "a file that is not a database is not an audit log");
      const socket = new WebSocket(`${base.replace("http", "ws")}/ws/events`);
      try {
        await new Promise((resolve, reject) => {
          socket.addEventListener("open", resolve, { once: true });
          socket.addEventListener("error", reject, { once: true });
        });
        server.broadcastNewAuditEvents();
        const received = new Promise<{ project?: string; data: { toolInput?: { command?: string } } }>((resolve) =>
          socket.addEventListener("message", (m) => resolve(JSON.parse(String(m.data))), { once: true }),
        );
        b.addEvent("echo live");
        assert.equal(server.broadcastNewAuditEvents(), 1);
        const message = await received;
        assert.equal(message.project, projects[1].id);
        assert.equal(message.data.toolInput?.command, "echo live");
      } finally {
        socket.close();
      }
    });
  } finally {
    b.cleanup();
    rmSync(broken, { recursive: true, force: true });
  }
});

test("Codex plans and explains in the folder of the project the request names", async () => {
  const a = auditProject("agentdock-mp-a-");
  const b = auditProject("agentdock-mp-b-");
  const ranIn: string[] = [];
  const codexRolesFor = (projectPath: string) => ({
    interview: async () => {
      ranIn.push(`interview ${projectPath}`);
      return { isRefined: false, clarificationQuestions: [] };
    },
    review: async () => {
      ranIn.push(`review ${projectPath}`);
      return { summary: "", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] };
    },
  });
  try {
    await withServer({ projectPaths: [a.dir, b.dir], codexEnabled: true, codexRolesFor }, async (base) => {
      const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as Listed;
      const post = (path: string) =>
        fetch(`${base}${path}?project=${projects[1].id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featurePrompt: "Add a flag" }),
        });
      assert.equal((await post("/api/supervisor/interview")).status, 200);
      assert.equal((await post("/api/reviewer/explain")).status, 200);
    });
    assert.deepEqual(ranIn, [`interview ${b.dir}`, `review ${b.dir}`]);
  } finally {
    a.cleanup();
    b.cleanup();
  }
});
