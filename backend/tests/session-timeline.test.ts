import test from "node:test";
import assert from "node:assert/strict";
import { AuditReader } from "../src/audit-reader.ts";
import { parseTimelineQuery, type TimelineQuery } from "../src/event-query.ts";
import { createAuditDb } from "./live-view-fixture.ts";

function query(qs = ""): TimelineQuery {
  const parsed = parseTimelineQuery(new URLSearchParams(qs));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

const TYPES = ["session_start", "user_prompt", "pre_tool", "post_tool", "stop", "pre_compact", "session_end"];

test("all event types come back in sequence order, 200 then 200 then 50, then nextAfter null", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedSession("other");
    a.seedEvents("s1", 450, (i) => ({ eventType: TYPES[i % TYPES.length] }));
    a.seedEvents("other", 5);
    const sizes: number[] = [];
    const seqs: number[] = [];
    let page = reader.sessionTimeline("s1", query())!;
    for (;;) {
      sizes.push(page.events.length);
      seqs.push(...page.events.map((e) => e.sequenceNum));
      if (page.nextAfter === null) break;
      page = reader.sessionTimeline(
        "s1",
        query(`after=${page.nextAfter.sequenceNum}&afterRow=${page.nextAfter.rowId}`),
      )!;
    }
    assert.deepEqual(sizes, [200, 200, 50]);
    assert.deepEqual(
      seqs,
      Array.from({ length: 450 }, (_, i) => i + 1),
    );
    const hooks = new Set(reader.sessionTimeline("s1", query("limit=7"))!.events.map((e) => e.hookEventName));
    assert.deepEqual([...hooks].sort(), [
      "PostToolUse",
      "PreCompact",
      "PreToolUse",
      "SessionEnd",
      "SessionStart",
      "Stop",
      "UserPromptSubmit",
    ]);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("after starts right after that event", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvents("s1", 20);
    const page = reader.sessionTimeline("s1", query("after=9&limit=3"))!;
    assert.deepEqual(
      page.events.map((e) => e.sequenceNum),
      [10, 11, 12],
    );
    assert.equal(page.nextAfter?.sequenceNum, 12);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("events that share a sequence number are neither skipped nor repeated across pages", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    for (const seq of [1, 2, 2, 2, 3, 4]) a.seedEvent("s1", { sequenceNum: seq });
    const rows: number[] = [];
    let page = reader.sessionTimeline("s1", query("limit=2"))!;
    for (;;) {
      rows.push(...page.events.map((e) => e.rowId));
      if (page.nextAfter === null) break;
      page = reader.sessionTimeline(
        "s1",
        query(`limit=2&after=${page.nextAfter.sequenceNum}&afterRow=${page.nextAfter.rowId}`),
      )!;
    }
    assert.equal(rows.length, 6);
    assert.equal(new Set(rows).size, 6);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("an unknown session id gives not found", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    assert.equal(reader.sessionTimeline("nope", query()), null);
    assert.deepEqual(reader.sessionTimeline("s1", query()), { events: [], nextAfter: null });
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a session that only exists in another project's database gives not found", () => {
  const a = createAuditDb();
  const b = createAuditDb();
  const readerA = new AuditReader(a.dir);
  try {
    b.seedSession("only-in-b");
    b.seedEvents("only-in-b", 3);
    assert.equal(readerA.sessionTimeline("only-in-b", query()), null);
  } finally {
    readerA.close();
    a.cleanup();
    b.cleanup();
  }
});

test("a blob-stored output comes back as outputStoredSeparately with its original size and never the ref", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { eventType: "post_tool", toolName: "Read", blobOriginalSize: 91234 });
    a.seedEvent("s1", { eventType: "post_tool", toolName: "Read", toolOutput: { content: "small" } });
    const [blob, small] = reader.sessionTimeline("s1", query())!.events;
    assert.deepEqual(blob.outputStoredSeparately, { originalSize: 91234 });
    assert.equal(blob.toolOutput, null);
    assert.equal(small.outputStoredSeparately, undefined);
    assert.deepEqual(small.toolOutput, { content: "small" });
    assert.ok(!JSON.stringify([blob, small]).includes("_blob_ref"));
  } finally {
    reader.close();
    a.cleanup();
  }
});
