import test from "node:test";
import assert from "node:assert/strict";
import {
  type DashboardEvent,
  agentLabel,
  eventTarget,
  filterStream,
  newlyArrived,
  projectName,
  recentApprovalRequests,
  streamCounts,
  unseenEvents,
} from "../src/lib/events.ts";

// The window the backend sends as `approvals.windowMs`.
const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

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

test("the target is the command or path the agent acted on", () => {
  assert.equal(eventTarget(event("a", { toolInput: { command: "npm test" } })), "npm test");
  assert.equal(eventTarget(event("b", { toolName: "Read", toolInput: { file_path: ".env" } })), ".env");
  assert.equal(
    eventTarget(event("c", { toolName: "Grep", toolInput: { pattern: "verifyTotp", path: "src" } })),
    "verifyTotp",
  );
  assert.equal(eventTarget(event("d", { toolInput: { other: 1 } })), '{"other":1}');
  assert.equal(eventTarget(event("e", { toolInput: undefined })), "");
});

test("stream counts follow the same labels as the chips", () => {
  const events = [
    event("1"),
    event("2", { decision: "DENY" }),
    event("3", { decision: "DENY" }),
    event("4", { decision: "REQUIRE_MANUAL_APPROVAL" }),
    event("5", { hookEventName: "PostToolUse", decision: undefined }),
  ];
  assert.deepEqual(streamCounts(events), { all: 5, blocked: 2, approval: 1 });
});

test("filter and search combine, and search ignores case across tool, target, rule, reason and agent", () => {
  const events = [
    event("1", {
      toolInput: { command: "git push --force origin main" },
      decision: "DENY",
      ruleId: "DESTRUCTIVE-SHELL",
    }),
    event("2", {
      toolName: "Read",
      toolInput: { file_path: ".env" },
      decision: "DENY",
      reason: "Secret files are never read",
    }),
    event("3", { agent: "codex", toolInput: { command: "npm test" } }),
    event("4", { decision: "REQUIRE_MANUAL_APPROVAL", toolInput: { command: "sudo apt install oathtool" } }),
  ];
  const ids = (list: DashboardEvent[]) => list.map((e) => e.id);
  assert.deepEqual(ids(filterStream(events, "all", "")), ["1", "2", "3", "4"]);
  assert.deepEqual(ids(filterStream(events, "Blocked", "")), ["1", "2"]);
  assert.deepEqual(ids(filterStream(events, "Needs approval", "")), ["4"]);
  assert.deepEqual(ids(filterStream(events, "all", "destructive")), ["1"]);
  assert.deepEqual(ids(filterStream(events, "all", "  SECRET ")), ["2"]);
  assert.deepEqual(ids(filterStream(events, "all", "CODEX")), ["3"]);
  assert.deepEqual(ids(filterStream(events, "Blocked", "npm")), []);
});

test("only approval requests from the last 15 minutes count as waiting, newest first", () => {
  const now = 10_000_000;
  const events = [
    event("old", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: now - APPROVAL_WINDOW_MS - 1 }),
    event("edge", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: now - APPROVAL_WINDOW_MS }),
    event("new", { decision: "REQUIRE_MANUAL_APPROVAL", timestamp: now - 1_000 }),
    event("deny", { decision: "DENY", timestamp: now - 1_000 }),
    event("observed", { decision: "REQUIRE_MANUAL_APPROVAL", observedOnly: true, timestamp: now - 1_000 }),
  ];
  assert.deepEqual(
    recentApprovalRequests({ windowMs: APPROVAL_WINDOW_MS, events }, now).map((e) => e.id),
    ["new", "edge"],
  );
});

test("while paused, only events the developer has not seen yet are counted as new", () => {
  const shown = [event("2"), event("1")];
  const latest = [event("4"), event("3"), event("2"), event("1")];
  assert.deepEqual(
    unseenEvents(latest, shown).map((e) => e.id),
    ["4", "3"],
  );
  assert.deepEqual(unseenEvents(shown, shown), []);
});

test("agent ids read as product names, unknown ones pass through", () => {
  assert.equal(agentLabel("claude-code"), "Claude Code");
  assert.equal(agentLabel("codex"), "Codex");
  assert.equal(agentLabel("opencode"), "OpenCode");
  assert.equal(agentLabel("unknown"), "unknown");
});

test("regression: the first load of a page does not mark every row as new", () => {
  const rows = [event("2"), event("1")];
  assert.deepEqual(newlyArrived(null, rows), []);
  assert.deepEqual(newlyArrived(new Set(), rows), []);
  assert.deepEqual(newlyArrived(new Set(["1"]), rows), ["2"]);
  assert.deepEqual(newlyArrived(new Set(["1", "2"]), rows), []);
});

test("the project name is the last folder of its path, on Windows or POSIX", () => {
  assert.equal(projectName("/home/me/sample-app/"), "sample-app");
  assert.equal(projectName("C:\\Users\\me\\sample-app"), "sample-app");
  assert.equal(projectName(undefined), "No project");
  assert.equal(projectName(""), "No project");
});
