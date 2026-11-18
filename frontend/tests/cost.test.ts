import test from "node:test";
import assert from "node:assert/strict";
import { type DashboardSession, type UsageTotals } from "../src/lib/events.ts";
import { COST_HELP, costView, formatTokens, formatUsd, projectCostView } from "../src/lib/cost.ts";

const usage = (over: Partial<UsageTotals> = {}): UsageTotals => ({
  inputTokens: 18_402,
  outputTokens: 61_077,
  cacheReadTokens: 1_038_950,
  cacheCreationTokens: 85_902,
  costUsd: 1.84,
  models: ["claude-haiku-5-5", "claude-opus-5-5"],
  estimated: false,
  ...over,
});

const session = (over: Partial<DashboardSession> = {}): DashboardSession => ({
  id: "s1",
  agent: "claude-code",
  projectPath: "/p",
  status: "completed",
  startedAt: 1,
  lastActivity: 2,
  toolCalls: 3,
  blockedCalls: 0,
  usage: null,
  hasTranscript: true,
  ...over,
});

test("recorded usage shows the cost, the compact token count and each kind of token", () => {
  const view = costView(session({ usage: usage() }), true);
  assert.equal(view.kind, "recorded");
  if (view.kind !== "recorded") return;
  assert.equal(view.costText, "$1.84");
  assert.equal(view.listText, "$1.84 · 1.2M tokens");
  assert.deepEqual(view.rows, [
    ["Total", "$1.84"],
    ["Input", "18,402 tokens"],
    ["Output", "61,077 tokens"],
    ["Cache read", "1,038,950 tokens"],
    ["Cache write", "85,902 tokens"],
    ["Models", "claude-haiku-5-5, claude-opus-5-5"],
  ]);
  assert.equal(view.estimated, false);
});

test("regression: a missing usage is never shown as $0 or 0 tokens", () => {
  const cases = [
    costView(session({ usage: null }), true),
    costView(session({ usage: null, status: "active" }), true),
    costView(session({ usage: null, hasTranscript: false }), true),
    costView(session({ agent: "codex", usage: null, hasTranscript: false }), true),
    costView(session({ usage: null }), false),
    projectCostView({ usage: null, usageRecorded: true }),
    projectCostView({ usage: null, usageRecorded: false }),
  ];
  for (const view of cases) {
    const text = JSON.stringify(view);
    assert.ok(!/\$0(\.0+)?\b/.test(text), text);
    assert.ok(!/\b0 tokens/.test(text), text);
    assert.notEqual(view.kind, "recorded");
  }
});

test("Codex, OpenCode and Claude Code without a transcript say Cost not available for <agent>", () => {
  assert.equal(costView(session({ agent: "codex", hasTranscript: false }), true).text, "Cost not available for Codex");
  assert.equal(
    costView(session({ agent: "opencode", hasTranscript: false }), true).text,
    "Cost not available for OpenCode",
  );
  assert.equal(costView(session({ hasTranscript: false }), true).text, "Cost not available for Claude Code");
  // Another agent's cost is never recordable, so an old CLI does not change the message.
  assert.equal(costView(session({ agent: "codex", hasTranscript: false }), false).text, "Cost not available for Codex");
});

test("Claude Code with a transcript but no rows says Cost not recorded, or not recorded yet while it works, with the help line", () => {
  const ended = costView(session(), true);
  assert.deepEqual([ended.kind, ended.text, ended.help], ["not-recorded", "Cost not recorded", COST_HELP]);
  assert.equal(costView(session({ status: "active" }), true).text, "Cost not recorded yet");
  assert.equal(COST_HELP, "Cost is recorded each time Claude Code stops, while the ctrlplane daemon is running.");
});

test("an old CLI says Cost not recorded: update the CLI, in the list, the detail and on the Overview card", () => {
  const view = costView(session(), false);
  assert.deepEqual(
    [view.kind, view.text, view.help],
    ["cli-too-old", "Cost not recorded: update the CLI", "Cost needs ctrlplane 0.3.0 or later."],
  );
  const card = projectCostView({ usage: null, usageRecorded: false });
  assert.deepEqual([card.kind, card.text], ["cli-too-old", "Cost not recorded: update the CLI"]);
});

test("an unknown model marks the session and the project total estimated", () => {
  const view = costView(session({ usage: usage({ estimated: true }) }), true);
  assert.equal(view.kind === "recorded" && view.estimated, true);
  const card = projectCostView({
    usage: { ...usage({ estimated: true, costUsd: 12.48 }), sessions: 14 },
    usageRecorded: true,
  });
  assert.deepEqual(card, { kind: "recorded", costText: "$12.48", sub: "across 14 sessions", estimated: true });
});

test("the Overview card counts sessions in words and says No cost recorded yet when the table is empty", () => {
  assert.equal(
    projectCostView({ usage: { ...usage({ costUsd: 0.004 }), sessions: 1 }, usageRecorded: true }).sub,
    "across 1 session",
  );
  const empty = projectCostView({ usage: null, usageRecorded: true });
  assert.deepEqual([empty.kind, empty.text, empty.help], ["none", "No cost recorded yet", COST_HELP]);
});

test("money: a cent or more has two decimals, a tiny cost is <$0.01, and a recorded zero stays $0.00", () => {
  assert.equal(formatUsd(1.84), "$1.84");
  assert.equal(formatUsd(1234.5), "$1,234.50");
  assert.equal(formatUsd(0.004), "<$0.01");
  assert.equal(formatUsd(0.01), "$0.01");
  assert.equal(formatUsd(0), "$0.00");
});

test("tokens: compact counts for the list", () => {
  assert.equal(formatTokens(950), "950");
  assert.equal(formatTokens(1_500), "1.5k");
  assert.equal(formatTokens(388_120), "388k");
  assert.equal(formatTokens(1_204_331), "1.2M");
  assert.equal(formatTokens(12_000_000), "12M");
});
