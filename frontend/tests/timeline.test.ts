import test from "node:test";
import assert from "node:assert/strict";
import { type PublicEvent, blobNote, timelineChip } from "../src/lib/events.ts";
import { nextTimelineCursor } from "../src/lib/search.ts";

const event = (over: Partial<PublicEvent> = {}): PublicEvent => ({
  id: "e1",
  rowId: 1,
  sequenceNum: 1,
  sessionId: "s1",
  timestamp: 1_000,
  hookEventName: "PreToolUse",
  agent: "claude-code",
  projectPath: "/p",
  toolName: "Bash",
  decision: "ALLOW",
  observedOnly: false,
  ...over,
});

test("every event type gets a labelled row", () => {
  const label = (over: Partial<PublicEvent>) => timelineChip(event(over));
  assert.deepEqual(label({ hookEventName: "SessionStart", toolName: undefined, decision: undefined }), {
    label: "Session started",
    tone: "event",
  });
  assert.equal(label({ hookEventName: "UserPromptSubmit", toolName: undefined }).label, "Prompt");
  assert.equal(label({ hookEventName: "Stop", toolName: undefined }).label, "Stopped");
  assert.equal(label({ hookEventName: "PreCompact", toolName: undefined }).label, "Compacted");
  assert.equal(label({ hookEventName: "SessionEnd", toolName: undefined }).label, "Session ended");
  assert.deepEqual(label({ decision: "DENY" }), { label: "Blocked", tone: "status" });
  assert.deepEqual(label({ hookEventName: "PostToolUse", decision: undefined }), {
    label: "Completed",
    tone: "status",
  });
  // A hook this dashboard does not know still gets its own name, never an empty chip.
  assert.deepEqual(label({ hookEventName: "Notification", toolName: undefined }), {
    label: "Notification",
    tone: "event",
  });
});

test("a blob event shows Output stored separately (N KB) and never the ref JSON", () => {
  const blob = event({
    hookEventName: "PostToolUse",
    toolOutput: null,
    outputStoredSeparately: { originalSize: 212 * 1024 + 1 },
  });
  assert.equal(blobNote(blob), "Output stored separately (213 KB)");
  assert.equal(blobNote(event({ outputStoredSeparately: { originalSize: 10 } })), "Output stored separately (1 KB)");
  assert.equal(blobNote(event({ toolOutput: { stdout: "ok" } })), null);
});

test("timeline paging stops when nextAfter is null", () => {
  assert.deepEqual(nextTimelineCursor({ events: [event()], nextAfter: { sequenceNum: 200, rowId: 4812 } }), {
    sequenceNum: 200,
    rowId: 4812,
  });
  assert.equal(nextTimelineCursor({ events: [event()], nextAfter: null }), null);
});
