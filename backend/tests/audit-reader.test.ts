import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AuditReader } from "../src/audit-reader.ts";

// The two tables the reader uses, as agentdock-cli creates them (packages/storage/src/db.ts).
// If the CLI changes them, this copy and the reader's queries must change together.
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
    execution_duration_ms INTEGER, created_at INTEGER NOT NULL
  );`;

function project() {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-audit-"));
  mkdirSync(join(dir, ".ctrlplane"));
  const writer = new DatabaseSync(join(dir, ".ctrlplane", "audit.db"));
  writer.exec(CLI_SCHEMA);
  let seq = 0;
  const addEvent = (session: string, type: string, verdict: string | null, reason: string | null, at: number) =>
    writer
      .prepare("INSERT INTO events VALUES (?, ?, ?, ?, 'Bash', ?, NULL, 0, ?, ?, 12, ?)")
      .run(`evt_${++seq}`, session, seq, type, JSON.stringify({ command: `cmd ${seq}` }), verdict, reason, at);
  const addSession = (id: string, status: string, startedAt: number, endedAt: number | null = null) =>
    writer
      .prepare("INSERT INTO sessions VALUES (?, 'claude-code', ?, 'main', 'abc', NULL, NULL, ?, ?, ?, NULL)")
      .run(id, dir, status, startedAt, endedAt);
  const cleanup = () => {
    writer.close();
    rmSync(dir, { recursive: true, force: true });
  };
  return { dir, writer, addEvent, addSession, cleanup };
}

test("a project without an audit database gives an empty, clearly unavailable snapshot", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-noaudit-"));
  try {
    const snap = new AuditReader(dir).snapshot();
    assert.equal(snap.source.available, false);
    assert.equal(snap.source.databasePath, join(dir, ".ctrlplane", "audit.db"));
    assert.deepEqual(snap.events, []);
    assert.equal(snap.counts.totalEvents, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the snapshot turns audit rows into dashboard sessions, events and counts", () => {
  const p = project();
  const reader = new AuditReader(p.dir);
  try {
    const now = 10_000_000;
    p.addSession("s1", "active", now - 1000);
    p.addSession("s2", "completed", now - 900_000, now - 800_000);
    p.addSession("s3", "active", now - 900_000);
    p.addEvent("s1", "pre_tool", "ALLOW", "Action passed all safety policies.", now - 500);
    p.addEvent("s1", "pre_tool", "DENY", "Recursive delete of the home folder", now - 400);
    p.addEvent("s1", "post_tool", null, null, now - 300);
    p.addEvent("s2", "pre_tool", "REQUIRE_MANUAL_APPROVAL", "Needs a human", now - 850_000);
    p.addEvent("s3", "pre_tool", "ALLOW", "Observe mode: would DENY — force push", now - 700_000);

    const snap = reader.snapshot(now);
    assert.equal(snap.source.available, true);
    assert.deepEqual(snap.counts, { toolCalls: 4, blockedCalls: 1, reviewCalls: 1, activeSessions: 1, totalEvents: 5 });

    // Newest first, hook names translated back, JSON columns parsed.
    assert.equal(snap.events[0].hookEventName, "PreToolUse");
    assert.equal(snap.events[0].observedOnly, true);
    assert.equal(snap.events[2].hookEventName, "PostToolUse");
    const denied = snap.events.find((e) => e.decision === "DENY")!;
    assert.deepEqual(denied.toolInput, { command: "cmd 2" });
    assert.equal(denied.agent, "claude-code");
    assert.equal(denied.latencyMs, 12);

    const byId = Object.fromEntries(snap.sessions.map((s) => [s.id, s]));
    assert.equal(byId.s1.status, "active");
    assert.equal(byId.s1.toolCalls, 2);
    assert.equal(byId.s1.blockedCalls, 1);
    assert.equal(byId.s2.status, "completed");
    assert.equal(byId.s3.status, "idle");
  } finally {
    reader.close();
    p.cleanup();
  }
});

test("poll announces only rows written after it started, oldest first", () => {
  const p = project();
  const reader = new AuditReader(p.dir);
  try {
    p.addSession("s1", "active", 1);
    p.addEvent("s1", "pre_tool", "ALLOW", null, 2);
    assert.deepEqual(reader.poll(), [], "rows from before the backend started are not new");
    p.addEvent("s1", "pre_tool", "DENY", "blocked", 3);
    p.addEvent("s1", "post_tool", null, null, 4);
    const fresh = reader.poll();
    assert.deepEqual(
      fresh.map((e) => e.hookEventName),
      ["PreToolUse", "PostToolUse"],
    );
    assert.deepEqual(reader.poll(), []);
  } finally {
    reader.close();
    p.cleanup();
  }
});

test("the reader can never change the audit database", () => {
  const p = project();
  const reader = new AuditReader(p.dir);
  try {
    p.addSession("s1", "active", 1);
    p.addEvent("s1", "pre_tool", "DENY", "blocked", 2);
    reader.snapshot();
    // Reach into the private connection: a write through it must be refused by SQLite itself.
    const db = (reader as unknown as { db: DatabaseSync }).db;
    assert.throws(() => db.exec("DELETE FROM events"), /readonly/i);
    assert.equal(reader.snapshot().counts.totalEvents, 1);
  } finally {
    reader.close();
    p.cleanup();
  }
});

test("a database file without the CLI's tables is shown as empty instead of crashing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-halfdb-"));
  mkdirSync(join(dir, ".ctrlplane"));
  new DatabaseSync(join(dir, ".ctrlplane", "audit.db")).close();
  const reader = new AuditReader(dir);
  try {
    assert.equal(reader.snapshot().counts.totalEvents, 0);
    assert.deepEqual(reader.poll(), []);
  } finally {
    reader.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("history stays readable after the daemon has stopped and closed the database", () => {
  const p = project();
  p.addSession("s1", "completed", 1, 5);
  p.addEvent("s1", "pre_tool", "DENY", "blocked", 2);
  // Closing the last writer checkpoints the WAL and removes its side files, as when `ctrlplane stop` runs.
  p.writer.close();
  const reader = new AuditReader(p.dir);
  try {
    assert.equal(reader.snapshot().counts.blockedCalls, 1);
  } finally {
    reader.close();
    rmSync(p.dir, { recursive: true, force: true });
  }
});
