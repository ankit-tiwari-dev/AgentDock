/**
 * Builds the image with compose.yaml, runs it against a throwaway project and checks that the container
 * behaves as docs/DECISIONS.md D-4 says: it shows the project's audit log, picks up new rows, accepts only
 * this machine's Host names, publishes its port on 127.0.0.1 only, and can write neither the project nor its
 * own files. Needs Docker with Compose v2. Run: npm run docker:smoke
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// The tables the backend reads, as agentdock-cli creates them (its packages/storage/src/db.ts), in WAL mode
// like the CLI. backend/tests/audit-reader.test.ts holds the same copy.
const CLI_SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, agent_type TEXT NOT NULL, project_path TEXT NOT NULL, git_branch TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL, head_commit_sha TEXT, spec_id TEXT, status TEXT NOT NULL,
    started_at INTEGER NOT NULL, ended_at INTEGER, metadata_json TEXT
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    sequence_num INTEGER NOT NULL, event_type TEXT NOT NULL, tool_name TEXT, tool_input_json TEXT,
    tool_output_json TEXT, is_blob_stored INTEGER NOT NULL DEFAULT 0, policy_verdict TEXT, policy_reason TEXT,
    execution_duration_ms INTEGER, created_at INTEGER NOT NULL, rule_id TEXT
  );`;

const PORT = Number(process.env.AGENTDOCK_SMOKE_PORT ?? 45899);
const PROJECT_NAME = "agentdock-smoke";

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

function run(cmd: string, args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string } {
  try {
    const out = execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env });
    return { code: 0, out: out.trim() };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}`.trim() };
  }
}

function get(path: string, host = `127.0.0.1:${PORT}`): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port: PORT, path, headers: { host } }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

type State = {
  source: { available: boolean };
  events: Array<{ id: string; toolName?: string; ruleId?: string }>;
};

async function eventIds(): Promise<string[]> {
  const { body } = await get("/api/dashboard/state");
  return (JSON.parse(body) as State).events.map((e) => e.id);
}

const dir = mkdtempSync(join(tmpdir(), "agentdock-smoke-"));
// mkdtemp makes the folder readable by its owner only. A project folder is normally readable by everyone, and on
// Linux the container's user (uid 1000) is not the owner, so give the copy a project folder's usual mode.
chmodSync(dir, 0o755);
mkdirSync(join(dir, ".ctrlplane"), { mode: 0o755 });
const db = new DatabaseSync(join(dir, ".ctrlplane", "audit.db"));
db.exec(CLI_SCHEMA);
const now = Date.now();
db.prepare(
  "INSERT INTO sessions VALUES ('ses_1', 'claude-code', ?, 'main', 'abc', NULL, NULL, 'active', ?, NULL, NULL)",
).run(dir, now);
let seq = 0;
const addEvent = (verdict: string, ruleId: string | null) =>
  db
    .prepare(
      "INSERT INTO events VALUES (?, 'ses_1', ?, 'pre_tool', 'Bash', '{\"command\":\"ls\"}', NULL, 0, ?, 'smoke', 3, ?, ?)",
    )
    .run(`evt_${++seq}`, seq, verdict, Date.now(), ruleId);
addEvent("ALLOW", null);
addEvent("DENY", "RULE-SMOKE");

const env = { ...process.env, AGENTDOCK_PROJECT_DIR: dir, AGENTDOCK_PORT: String(PORT) };
const compose = (...args: string[]) => run("docker", ["compose", "-p", PROJECT_NAME, ...args], env);

try {
  const up = compose("up", "--build", "--detach", "--wait", "--wait-timeout", "60");
  check("the image builds and the container becomes healthy", up.code === 0, up.code === 0 ? "" : up.out.slice(-800));
  if (up.code !== 0) throw new Error("container did not start");

  const health = await get("/api/health");
  check("GET /api/health answers 200", health.status === 200, String(health.status));

  const page = await get("/");
  check("the dashboard page is served", page.status === 200 && page.body.includes("<html"), String(page.status));

  const state = JSON.parse((await get("/api/dashboard/state")).body) as State;
  check(
    "the project's audit log is shown, with the rule that decided a call",
    state.events.length === 2 && state.events.some((e) => e.ruleId === "RULE-SMOKE"),
    `file found: ${state.source.available}, events: ${JSON.stringify(state.events.map((e) => [e.id, e.ruleId ?? null]))}`,
  );

  addEvent("ALLOW", null);
  const started = Date.now();
  let seen = false;
  while (!seen && Date.now() - started < 3000) {
    seen = (await eventIds()).includes(`evt_${seq}`);
    if (!seen) await new Promise((r) => setTimeout(r, 200));
  }
  check("a row written on the host appears within 3 s", seen, `${Date.now() - started} ms`);

  const foreign = await get("/api/health", `192.168.1.20:${PORT}`);
  check("a Host header from the network gets 403", foreign.status === 403, String(foreign.status));

  const ps = compose("ps", "--quiet", "agentdock");
  const id = ps.out.split("\n")[0];
  const bindings = run("docker", ["inspect", "--format", "{{json .HostConfig.PortBindings}}", id]).out;
  const hostIps = [...bindings.matchAll(/"HostIp":"([^"]*)"/g)].map((m) => m[1]);
  check(
    "the port is published to 127.0.0.1 only",
    hostIps.length > 0 && hostIps.every((ip) => ip === "127.0.0.1"),
    bindings,
  );

  const uid = compose("exec", "-T", "agentdock", "id", "-u");
  check("the server runs as a non-root user", uid.code === 0 && uid.out !== "0", `uid ${uid.out}`);

  // A failed write alone could be file permissions; the mount itself must be read-only.
  const mounts = run("docker", ["inspect", "--format", "{{json .Mounts}}", id]).out;
  const project = (JSON.parse(mounts || "[]") as Array<{ Destination: string; RW: boolean }>).find(
    (m) => m.Destination === "/project",
  );
  check("the project is mounted read-only", project?.RW === false, mounts);

  const writeProject = compose("exec", "-T", "agentdock", "touch", "/project/written-by-container");
  check("the container cannot write to the project", writeProject.code !== 0, writeProject.out);

  const writeApp = compose("exec", "-T", "agentdock", "touch", "/app/backend/src/x.ts");
  check("the container cannot change its own files", writeApp.code !== 0, writeApp.out);

  const writeRoot = compose("exec", "-T", "agentdock", "touch", "/written-by-container");
  check("the root filesystem is read-only", writeRoot.code !== 0, writeRoot.out);
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  console.log(compose("logs", "--no-color").out.slice(-2000));
  failures++;
} finally {
  compose("down", "--volumes", "--remove-orphans");
  db.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? "docker smoke test passed" : `docker smoke test: ${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
