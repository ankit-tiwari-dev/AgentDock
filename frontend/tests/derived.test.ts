import test from "node:test";
import assert from "node:assert/strict";
import {
  type DashboardEvent,
  approvalRequests,
  eventStatus,
  eventTarget,
  nextApprovalExpiry,
  ranAfterwards,
  ranAfterwardsIndex,
  recentApprovalRequests,
  sessionSummaries,
  sessionTimeline,
  verdictStrip,
} from "../src/lib/events.ts";

const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

// The per-request scan the index replaced, kept here as the oracle for D-7's "Ran afterwards".
function oracleRanAfterwards(request: DashboardEvent, events: DashboardEvent[]): boolean {
  const target = eventTarget(request);
  const same = (event: DashboardEvent) =>
    event.sessionId === request.sessionId && event.toolName === request.toolName && eventTarget(event) === target;
  const askedAgain = events
    .filter(
      (event) =>
        event.id !== request.id &&
        eventStatus(event) === "Needs approval" &&
        event.timestamp > request.timestamp &&
        same(event),
    )
    .reduce((first, event) => Math.min(first, event.timestamp), Infinity);
  return events.some(
    (event) =>
      event.hookEventName === "PostToolUse" &&
      event.timestamp >= request.timestamp &&
      event.timestamp < askedAgain &&
      same(event),
  );
}

// A seeded generator, so a failing sequence can be replayed from its seed.
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(next: () => number, items: readonly T[]): T => items[Math.floor(next() * items.length)] as T;

const INPUTS: unknown[] = [
  { command: "npm publish" },
  { command: "git push" },
  { file_path: "a.ts" },
  { command: "", path: "a.ts" },
  "a.ts",
  { other: 1 },
  undefined,
];

function randomEvent(next: () => number, id: string): DashboardEvent {
  const post = next() < 0.4;
  return {
    id,
    sessionId: pick(next, ["s1", "s2", "s|1"]),
    timestamp: Math.floor(next() * 12),
    hookEventName: post ? "PostToolUse" : pick(next, ["PreToolUse", "PreToolUse", "SessionStart"]),
    agent: "claude-code",
    projectPath: "/p",
    toolName: pick(next, ["Bash", "Write", undefined]),
    toolInput: pick(next, INPUTS),
    toolOutput: post && next() < 0.3 ? { exit_code: 1 } : undefined,
    decision: post ? undefined : pick(next, ["REQUIRE_MANUAL_APPROVAL", "REQUIRE_MANUAL_APPROVAL", "ALLOW", "DENY"]),
    observedOnly: next() < 0.1,
  };
}

function randomEvents(next: () => number, prefix: string): DashboardEvent[] {
  return Array.from({ length: Math.floor(next() * 40) }, (_, i) => randomEvent(next, `${prefix}${i}`));
}

test("regression: the Ran-afterwards index answers every request like the per-request scan it replaced", () => {
  for (let seed = 1; seed <= 400; seed++) {
    const next = random(seed);
    const events = randomEvents(next, "e");
    // Requests come from the list itself, from outside it, and with an id the list already uses.
    const outside = randomEvents(next, "x");
    const clashing = events.slice(0, 3).map((event) => ({ ...randomEvent(next, event.id) }));
    const ran = ranAfterwardsIndex(events);
    for (const request of [...events, ...outside, ...clashing]) {
      const expected = oracleRanAfterwards(request, events);
      assert.equal(ran(request), expected, `seed ${seed}, request ${JSON.stringify(request)}`);
      assert.equal(ranAfterwards(request, events), expected, `seed ${seed}, wrapper, request ${request.id}`);
    }
  }
});

test("regression: the waiting list and its counts are unchanged by the index", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const now = 20;
    const windowMs = 6;
    const events = randomEvents(next, "e");
    const approvals = { windowMs, events: randomEvents(next, "a") };
    const { recent, earlier, waiting, open } = approvalRequests({ events, approvals }, now);
    const expectedRecent = recentApprovalRequests(approvals, now);
    const expectedWaiting = expectedRecent.filter((event) => !oracleRanAfterwards(event, approvals.events));
    assert.deepEqual(
      recent.map((e) => e.id),
      expectedRecent.map((e) => e.id),
    );
    assert.deepEqual(
      waiting.map((e) => e.id),
      expectedWaiting.map((e) => e.id),
      `seed ${seed}`,
    );
    assert.equal(open, expectedWaiting.length);
    assert.ok(earlier.every((e) => now - e.timestamp > windowMs));
  }
});

test("regression: each session's list row counts and marks the same calls as a scan of every event per session", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const next = random(seed);
    const events = randomEvents(next, "e");
    const summaries = sessionSummaries(events);
    for (const id of ["s1", "s2", "s|1", "none"]) {
      const timeline = sessionTimeline(events, id);
      const waiting = timeline.filter(
        (event) => eventStatus(event) === "Needs approval" && !oracleRanAfterwards(event, events),
      ).length;
      const summary = summaries.get(id) ?? { waiting: 0, marks: [] };
      assert.equal(summary.waiting, waiting, `seed ${seed}, session ${id}`);
      assert.deepEqual(summary.marks, verdictStrip(timeline), `seed ${seed}, session ${id}`);
    }
  }
});

test("a request leaves the 15-minute window at the time the next expiry names, not a tick later", () => {
  const now = 10 * APPROVAL_WINDOW_MS;
  const ask = (id: string, timestamp: number, decision = "REQUIRE_MANUAL_APPROVAL"): DashboardEvent => ({
    id,
    sessionId: "s1",
    timestamp,
    hookEventName: "PreToolUse",
    agent: "claude-code",
    projectPath: "/p",
    toolName: "Bash",
    toolInput: { command: id },
    decision,
    observedOnly: false,
  });
  const approvals = {
    windowMs: APPROVAL_WINDOW_MS,
    events: [ask("new", now - 1_000), ask("old", now - 60_000), ask("allowed", now - 90_000, "ALLOW")],
  };
  const expiry = nextApprovalExpiry(approvals, now);
  assert.equal(expiry, now - 60_000 + APPROVAL_WINDOW_MS + 1);
  assert.deepEqual(
    recentApprovalRequests(approvals, (expiry ?? 0) - 1).map((e) => e.id),
    ["new", "old"],
  );
  assert.deepEqual(
    recentApprovalRequests(approvals, expiry ?? 0).map((e) => e.id),
    ["new"],
  );
  assert.equal(nextApprovalExpiry(approvals, now + APPROVAL_WINDOW_MS), null);
});
