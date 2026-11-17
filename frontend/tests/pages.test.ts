import test from "node:test";
import assert from "node:assert/strict";
import {
  type DashboardEvent,
  APPROVAL_WINDOW_MS,
  approvalRequests,
  formatUptime,
  pageFromHash,
  ranAfterwards,
  sessionTimeline,
  summarizeRules,
  verdictStrip,
} from "../src/lib/events.ts";

const event = (id: string, over: Partial<DashboardEvent> = {}): DashboardEvent => ({
  id,
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
const ask = (id: string, command: string, timestamp: number, sessionId = "s1") =>
  event(id, { decision: "REQUIRE_MANUAL_APPROVAL", toolInput: { command }, timestamp, sessionId });
const done = (id: string, command: string, timestamp: number, sessionId = "s1") =>
  event(id, { hookEventName: "PostToolUse", decision: undefined, toolInput: { command }, timestamp, sessionId });

test("the page comes from the address hash, and anything unknown opens the Overview", () => {
  assert.equal(pageFromHash("#sessions"), "sessions");
  assert.equal(pageFromHash("#waiting"), "waiting");
  assert.equal(pageFromHash(""), "overview");
  assert.equal(pageFromHash("#activity"), "overview");
  assert.equal(pageFromHash("#coach"), "overview");
});

test("the Settings page comes from #settings", () => {
  assert.equal(pageFromHash("#settings"), "settings");
});

test("an approval request ran only if the same session later completed the same command", () => {
  const request = ask("a", "npm publish", 100);
  assert.equal(ranAfterwards(request, [done("d", "npm publish", 200), request]), true);
  assert.equal(ranAfterwards(request, [done("d", "npm publish --tag next", 200), request]), false);
  assert.equal(ranAfterwards(request, [done("d", "npm publish", 200, "s2"), request]), false);
  // Reading a file after asking to write it is not the write running.
  const write = event("w", {
    decision: "REQUIRE_MANUAL_APPROVAL",
    toolName: "Write",
    toolInput: { file_path: "m.sql" },
  });
  const read = { ...done("r", "", 2_000), toolName: "Read", toolInput: { file_path: "m.sql" } };
  assert.equal(ranAfterwards(write, [read, write]), false);
  // A completion from before the request belongs to an earlier run of the command.
  assert.equal(ranAfterwards(request, [request, done("d", "npm publish", 50)]), false);
});

test("regression: a completion answers only the newest request before it, so a denied request does not look run", () => {
  const denied = ask("denied", "git push", 100);
  const approved = ask("approved", "git push", 200);
  const events = [done("d", "git push", 300), approved, denied];
  assert.equal(ranAfterwards(approved, events), true);
  assert.equal(ranAfterwards(denied, events), false);
});

test("approval requests split at 15 minutes, and only unanswered recent ones count as open", () => {
  const now = 10 * APPROVAL_WINDOW_MS;
  const events = [
    done("d", "git push origin main", now - 1_000),
    ask("recent-ran", "git push origin main", now - 2_000),
    ask("recent-open", "npm publish", now - 3_000),
    ask("old", "gh pr merge 3", now - APPROVAL_WINDOW_MS - 1),
    event("allowed", { timestamp: now - 500 }),
  ];
  const { recent, earlier, open } = approvalRequests(events, now);
  assert.deepEqual(
    recent.map((e) => e.id),
    ["recent-ran", "recent-open"],
  );
  assert.deepEqual(
    earlier.map((e) => e.id),
    ["old"],
  );
  assert.equal(open, 1);
});

test("regression: the Overview's waiting list leaves out requests that ran afterwards", () => {
  const now = 10 * APPROVAL_WINDOW_MS;
  const events = [
    done("d", "git push origin main", now - 1_000),
    ask("recent-ran", "git push origin main", now - 2_000),
    ask("recent-open", "npm publish", now - 3_000),
  ];
  assert.deepEqual(
    approvalRequests(events, now).waiting.map((e) => e.id),
    ["recent-open"],
  );
});

test("a session's timeline holds its own tool calls, newest first", () => {
  const events = [
    event("b", { timestamp: 3 }),
    event("other", { sessionId: "s2", timestamp: 4 }),
    event("start", { hookEventName: "SessionStart", toolName: undefined, timestamp: 1 }),
    event("a", { timestamp: 2 }),
  ];
  assert.deepEqual(
    sessionTimeline(events, "s1").map((e) => e.id),
    ["b", "a"],
  );
});

test("the verdict strip has one mark per call, oldest first, and keeps only the newest calls", () => {
  const timeline = [
    event("3", { decision: "DENY", timestamp: 3 }),
    done("2b", "x", 2),
    event("2", { decision: "INSTRUCT", timestamp: 2 }),
    event("1", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: 1 }),
    event("0", { decision: "ALLOW", reason: "Observe mode: would DENY", observedOnly: true, timestamp: 0 }),
  ];
  assert.deepEqual(verdictStrip(timeline), ["observed", "approval", "guidance", "blocked"]);
  assert.deepEqual(verdictStrip(timeline, 2), ["guidance", "blocked"]);
});

test("a rule's summary counts each verdict and keeps its calls, newest first", () => {
  const [rule] = summarizeRules([
    { ...event("2", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: 2 }), ruleId: "RULE-PKG-PUBLISH" },
    { ...event("1", { decision: "DENY", timestamp: 1 }), ruleId: "RULE-PKG-PUBLISH" },
    { ...event("3", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: 3 }), ruleId: "RULE-PKG-PUBLISH" },
  ]);
  assert.deepEqual(rule.counts, { "Needs approval": 2, Blocked: 1 });
  assert.deepEqual(
    rule.events.map((e) => e.id),
    ["3", "2", "1"],
  );
});

test("the backend uptime reads in hours and minutes", () => {
  assert.equal(formatUptime(30), "under a minute");
  assert.equal(formatUptime(125), "2 min");
  assert.equal(formatUptime(8_040), "2 h 14 min");
});
