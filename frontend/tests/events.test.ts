import test from "node:test";
import assert from "node:assert/strict";
import {
  type DashboardEvent,
  eventStatus,
  isToolFailure,
  relativeTime,
  summarize,
  summarizeRules,
} from "../src/lib/events.ts";

const pre = (decision: string, reason: string, timestamp = 1, observedOnly = false): DashboardEvent => ({
  id: `${decision}-${timestamp}`,
  sessionId: "s",
  timestamp,
  hookEventName: "PreToolUse",
  agent: "claude-code",
  projectPath: "/p",
  toolName: "Bash",
  decision,
  reason,
  observedOnly,
});

test("each decision gets the label the activity filter uses", () => {
  assert.equal(eventStatus(pre("DENY", "x")), "Blocked");
  assert.equal(eventStatus(pre("REQUIRE_MANUAL_APPROVAL", "x")), "Needs approval");
  assert.equal(eventStatus(pre("INSTRUCT", "x")), "Guidance");
  assert.equal(eventStatus(pre("ALLOW", "ok")), "Allowed");
  // An observe-mode hit is allowed but must not look like a clean pass.
  assert.equal(eventStatus(pre("ALLOW", "Observe mode: would DENY — x", 1, true)), "Observed");
  const post = { ...pre("ALLOW", ""), hookEventName: "PostToolUse" };
  assert.equal(eventStatus({ ...post, toolOutput: { exit_code: 1 } }), "Failed");
  assert.equal(eventStatus({ ...post, toolOutput: { exit_code: 0 } }), "Completed");
});

test("tool failures are recognised in the shapes agents report them", () => {
  assert.equal(isToolFailure({ is_error: true }), true);
  assert.equal(isToolFailure({ success: false }), true);
  assert.equal(isToolFailure("Error: not found"), true);
  assert.equal(isToolFailure("all good"), false);
  assert.equal(isToolFailure(undefined), false);
});

test("rules are grouped by their message, and a clean ALLOW is not a rule hit", () => {
  const rules = summarizeRules([
    pre("ALLOW", "Action passed all safety policies.", 1),
    pre("DENY", "Recursive delete of the home folder\nUse a narrower path.", 2),
    pre("DENY", "Recursive delete of the home folder\nUse a narrower path.", 5),
    pre("ALLOW", "Observe mode: would DENY — force push", 3, true),
  ]);
  assert.deepEqual(
    rules.map((r) => [r.id, r.count, r.latestDecision]),
    [
      ["Recursive delete of the home folder", 2, "Blocked"],
      ["Observe mode: would DENY — force push", 1, "Observed"],
    ],
  );
});

test("long payloads are shortened and times read naturally", () => {
  assert.equal(summarize("x".repeat(200)).length, 148);
  assert.equal(summarize({ a: 1 }), '{"a":1}');
  assert.equal(relativeTime(0, 5_000), "Just now");
  assert.equal(relativeTime(0, 90_000), "1m ago");
});
