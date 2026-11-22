import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AgentDockBackendServer } from "../src/server.ts";
import { applyCliSchema } from "./live-view-fixture.ts";

function auditProject() {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-api-"));
  mkdirSync(join(dir, ".ctrlplane"));
  const db = new DatabaseSync(join(dir, ".ctrlplane", "audit.db"));
  applyCliSchema(db, { withRuleId: false, withUsage: false, withCreatedAtIndex: false });
  db.prepare(
    "INSERT INTO sessions VALUES ('s1', 'claude-code', ?, 'main', 'abc', NULL, NULL, 'active', ?, NULL, NULL)",
  ).run(dir, Date.now());
  let seq = 0;
  const addEvent = (verdict: string) =>
    db
      .prepare(
        "INSERT INTO events (id, session_id, sequence_num, event_type, tool_name, tool_input_json, tool_output_json, is_blob_stored, policy_verdict, policy_reason, execution_duration_ms, created_at) VALUES (?, 's1', ?, 'pre_tool', 'Bash', '{\"command\":\"ls\"}', NULL, 0, ?, NULL, 3, ?)",
      )
      .run(`evt_${++seq}`, seq, verdict, Date.now());
  return { dir, addEvent, cleanup: () => (db.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("the dashboard state comes from the project's audit database", async () => {
  const p = auditProject();
  p.addEvent("DENY");
  const server = new AgentDockBackendServer({ port: 0, projectPath: p.dir });
  const { port } = await server.start();
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/dashboard/state`);
    assert.equal(res.status, 200);
    const state = (await res.json()) as { source: { available: boolean }; counts: { blockedCalls: number } };
    assert.equal(state.source.available, true);
    assert.equal(state.counts.blockedCalls, 1);
  } finally {
    await server.stop();
    p.cleanup();
  }
});

test("a row the daemon writes is streamed to connected dashboards", async () => {
  const p = auditProject();
  const server = new AgentDockBackendServer({ port: 0, projectPath: p.dir });
  const { port } = await server.start();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws/events`);
  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    assert.equal(server.broadcastNewAuditEvents(), 0, "the first tick only marks where the log ends");
    const received = new Promise<{ type: string; data: { decision: string } }>((resolve) =>
      socket.addEventListener("message", (m) => resolve(JSON.parse(String(m.data))), { once: true }),
    );
    p.addEvent("ALLOW");
    assert.equal(server.broadcastNewAuditEvents(), 1);
    const message = await received;
    assert.equal(message.type, "agent_tool_executing");
    assert.equal(message.data.decision, "ALLOW");
  } finally {
    socket.close();
    await server.stop();
    p.cleanup();
  }
});
