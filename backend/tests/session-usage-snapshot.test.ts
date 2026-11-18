import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AuditReader } from "../src/audit-reader.ts";
import { parseSearchQuery, parseTimelineQuery } from "../src/event-query.ts";
import { createAuditDb } from "./live-view-fixture.ts";

const searchAll = () => {
  const p = parseSearchQuery(new URLSearchParams("q=echo"));
  if (!p.ok) throw new Error(p.error);
  return p.value;
};
const timelineAll = () => {
  const p = parseTimelineQuery(new URLSearchParams(""));
  if (!p.ok) throw new Error(p.error);
  return p.value;
};

test("each session in the snapshot carries its usage summed over models, its model list and the estimated flag", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1", { transcriptPath: "/home/dev/.claude/projects/p/s1.jsonl" });
    a.seedSession("s2", { transcriptPath: "/home/dev/.claude/projects/p/s2.jsonl" });
    a.seedSession("cx", { agent: "codex" });
    a.seedUsage("s1", [
      {
        model: "claude-opus-5-5",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 1000,
        cacheCreationTokens: 200,
        costUsd: 0.0026,
      },
      { model: "claude-nova-9", inputTokens: 10, outputTokens: 20, costUsd: 0.00033, unknownModel: true },
    ]);
    a.seedUsage("s2", [{ model: "claude-sonnet-5-5", inputTokens: 1, outputTokens: 2, costUsd: 0.000022 }]);

    const snap = reader.snapshot();
    const byId = new Map(snap.sessions.map((s) => [s.id, s]));
    assert.deepEqual(byId.get("s1")?.usage, {
      inputTokens: 110,
      outputTokens: 70,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      costUsd: 0.00293,
      models: ["claude-nova-9", "claude-opus-5-5"],
      estimated: true,
    });
    assert.equal(byId.get("s2")?.usage?.estimated, false);
    assert.equal(byId.get("cx")?.usage, null);
    assert.equal(snap.counts.usageRecorded, true);
    assert.deepEqual(snap.counts.usage, {
      inputTokens: 111,
      outputTokens: 72,
      cacheReadTokens: 1000,
      cacheCreationTokens: 200,
      costUsd: 0.002952,
      models: ["claude-nova-9", "claude-opus-5-5", "claude-sonnet-5-5"],
      estimated: true,
      sessions: 2,
    });
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("the project total covers recorded sessions outside the newest 500", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.db.exec("BEGIN;");
    for (let i = 0; i < 510; i++) a.seedSession(`s${i}`, { startedAt: 1000 + i });
    a.db.exec("COMMIT;");
    a.seedUsage("s0", [{ model: "claude-opus-5-5", inputTokens: 5, costUsd: 0.5 }]);
    a.seedUsage("s509", [{ model: "claude-opus-5-5", inputTokens: 7, costUsd: 0.25 }]);
    const snap = reader.snapshot();
    assert.equal(snap.sessions.length, 500);
    assert.ok(!snap.sessions.some((s) => s.id === "s0"));
    assert.equal(snap.counts.usage?.sessions, 2);
    assert.equal(snap.counts.usage?.costUsd, 0.75);
    assert.equal(snap.counts.usage?.inputTokens, 12);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a recorded table with no rows gives a null total but usageRecorded true", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    const snap = reader.snapshot();
    assert.equal(snap.counts.usageRecorded, true);
    assert.equal(snap.counts.usage, null);
    assert.equal(snap.sessions[0].usage, null);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a database without session_usage gives usage null and usageRecorded false, and search and the timeline still work", () => {
  const a = createAuditDb({ withUsage: false, withCreatedAtIndex: false });
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvents("s1", 3);
    const snap = reader.snapshot();
    assert.equal(snap.counts.usageRecorded, false);
    assert.equal(snap.counts.usage, null);
    assert.equal(snap.sessions[0].usage, null);
    assert.equal(snap.events.length, 3);
    assert.equal(reader.searchEvents(searchAll()).events.length, 3);
    assert.equal(reader.sessionTimeline("s1", timelineAll())?.events.length, 3);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a session_usage table created while the backend runs is picked up on the next read", () => {
  const a = createAuditDb({ withUsage: false });
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    assert.equal(reader.snapshot().counts.usageRecorded, false);
    a.db.exec(`CREATE TABLE session_usage (
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0, unknown_model INTEGER NOT NULL DEFAULT 0, turns INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL, PRIMARY KEY (session_id, model));`);
    a.seedUsage("s1", [{ model: "claude-opus-5-5", inputTokens: 3, costUsd: 0.1 }]);
    const snap = reader.snapshot();
    assert.equal(snap.counts.usageRecorded, true);
    assert.equal(snap.sessions[0].usage?.costUsd, 0.1);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("hasTranscript is true or false and no response holds the transcript path", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    const path = "C:\\Users\\dev\\.claude\\projects\\p\\with.jsonl";
    a.seedSession("with", { transcriptPath: path });
    a.seedSession("without");
    a.seedSession("other-meta", { metadataJson: JSON.stringify({ note: "x" }) });
    a.seedSession("broken-meta", { metadataJson: "{not json" });
    a.seedEvents("with", 2);
    const snap = reader.snapshot();
    const has = Object.fromEntries(snap.sessions.map((s) => [s.id, s.hasTranscript]));
    assert.deepEqual(has, { with: true, without: false, "other-meta": false, "broken-meta": false });
    const bodies = JSON.stringify([
      snap,
      reader.searchEvents(searchAll()),
      reader.sessionTimeline("with", timelineAll()),
    ]);
    assert.ok(!bodies.includes("with.jsonl"));
    assert.ok(!bodies.includes("transcriptPath"));
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("the reader never writes: the database file's bytes are unchanged after every read", () => {
  const a = createAuditDb();
  a.seedSession("s1");
  a.seedEvents("s1", 5);
  a.seedUsage("s1", [{ model: "claude-opus-5-5", costUsd: 1 }]);
  a.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  a.db.close();
  const before = readFileSync(a.dbPath);
  const reader = new AuditReader(a.dir);
  try {
    reader.snapshot();
    reader.searchEvents(searchAll());
    reader.sessionTimeline("s1", timelineAll());
    reader.close();
    assert.ok(readFileSync(a.dbPath).equals(before));
  } finally {
    reader.close();
    a.cleanup();
  }
});
