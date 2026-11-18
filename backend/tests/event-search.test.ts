import test from "node:test";
import assert from "node:assert/strict";
import { AuditReader } from "../src/audit-reader.ts";
import { parseSearchQuery, type SearchQuery } from "../src/event-query.ts";
import { createAuditDb } from "./live-view-fixture.ts";

function query(qs: string): SearchQuery {
  const parsed = parseSearchQuery(new URLSearchParams(qs));
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

test("an old event outside the newest 500 is found", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { toolInput: { command: "grep needle-alpha src" } });
    a.seedEvents("s1", 599);
    assert.ok(!reader.snapshot().events.some((e) => JSON.stringify(e.toolInput).includes("needle-alpha")));
    const { events, nextBefore } = reader.searchEvents(query("q=needle-alpha"));
    assert.equal(events.length, 1);
    assert.equal(events[0].sequenceNum, 1);
    assert.equal(events[0].sessionId, "s1");
    assert.equal(events[0].agent, "claude-code");
    assert.equal(nextBefore, null);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("pages come newest first, 50 at a time, with no repeat or gap when new matching rows arrive between pages", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    const ids = a.seedEvents("s1", 120, (i) => ({ toolInput: { command: `run match-${i}` } }));
    a.seedEvents("s1", 30, () => ({ toolInput: { command: "other" } }));
    const seen: number[] = [];
    let page = reader.searchEvents(query("q=match-"));
    seen.push(...page.events.map((e) => e.rowId));
    assert.equal(page.events.length, 50);
    // New matching rows land between page loads; older pages must not show them.
    a.seedEvents("s1", 10, (i) => ({ toolInput: { command: `run match-new-${i}` } }));
    while (page.nextBefore !== null) {
      page = reader.searchEvents(query(`q=match-&before=${page.nextBefore}`));
      seen.push(...page.events.map((e) => e.rowId));
    }
    assert.deepEqual(seen, [...ids].reverse());
    assert.equal(page.events.length, 20);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("filters combine with AND, removing one widens the result, and filters work without q", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("cc", { agent: "claude-code" });
    a.seedSession("cx", { agent: "codex" });
    a.seedEvent("cc", { toolName: "Bash", verdict: "DENY", createdAt: 1000, toolInput: { command: "rm -rf x" } });
    a.seedEvent("cc", { toolName: "Bash", verdict: "ALLOW", createdAt: 2000, toolInput: { command: "rm -rf y" } });
    a.seedEvent("cx", { toolName: "Bash", verdict: "DENY", createdAt: 3000, toolInput: { command: "rm -rf z" } });
    a.seedEvent("cx", { toolName: "Edit", verdict: "DENY", createdAt: 4000, toolInput: { path: "rm -rf.md" } });

    const count = (qs: string) => reader.searchEvents(query(qs)).events.length;
    assert.equal(count("q=rm -rf&agent=codex&verdict=DENY&tool=Bash"), 1);
    assert.equal(count("q=rm -rf&agent=codex&verdict=DENY"), 2);
    assert.equal(count("q=rm -rf&verdict=DENY"), 3);
    assert.equal(count("q=rm -rf"), 4);
    assert.equal(count("verdict=DENY"), 3);
    assert.equal(count("agent=claude-code"), 2);
    assert.equal(count("from=2000&to=4000"), 2);
    assert.equal(count("from=2000"), 3);
    assert.equal(count("to=2000"), 1);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("50% matches only a literal 50%, a_b does not match axb, and a backslash matches a backslash", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { toolInput: { command: "echo 500 done" } });
    a.seedEvent("s1", { toolInput: { command: "echo 50% done" } });
    a.seedEvent("s1", { toolInput: { command: "axb" } });
    a.seedEvent("s1", { toolInput: { command: "a_b" } });
    a.seedEvent("s1", { toolInput: { command: "dir a\\b" } });
    a.seedEvent("s1", { toolInput: { command: "dir a/b" } });
    const commands = (qs: string) =>
      reader.searchEvents(query(qs)).events.map((e) => (e.toolInput as { command: string }).command);
    assert.deepEqual(commands("q=50%25"), ["echo 50% done"]);
    assert.deepEqual(commands("q=a_b"), ["a_b"]);
    assert.deepEqual(commands("q=a%5Cb"), ["dir a\\b"]);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a Windows path typed with single backslashes finds the stored JSON text", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { toolName: "Read", toolInput: { file_path: "C:\\Users\\dev\\app\\main.ts" } });
    a.seedEvent("s1", { toolName: "Read", toolInput: { file_path: "/home/dev/app/main.ts" } });
    const found = reader.searchEvents(query(`q=${encodeURIComponent("C:\\Users\\dev")}`)).events;
    assert.equal(found.length, 1);
    assert.deepEqual(found[0].toolInput, { file_path: "C:\\Users\\dev\\app\\main.ts" });
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("search matches the tool name, the reason and the rule id, case-insensitively", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { toolName: "WebFetch" });
    a.seedEvent("s1", { reason: "Force push to main is blocked" });
    a.seedEvent("s1", { ruleId: "git.no-force-push" });
    a.seedEvent("s1", { toolOutput: { stdout: "Deploy finished" } });
    const count = (q: string) => reader.searchEvents(query(`q=${encodeURIComponent(q)}`)).events.length;
    assert.equal(count("webfetch"), 1);
    assert.equal(count("force push"), 1);
    assert.equal(count("no-force"), 1);
    assert.equal(count("deploy finished"), 1);
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("blob-stored outputs are not searched and come back as outputStoredSeparately", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1");
    a.seedEvent("s1", { toolInput: { command: "cat big.log" }, blobOriginalSize: 91234 });
    assert.equal(reader.searchEvents(query("q=_blob_ref")).events.length, 0);
    assert.equal(reader.searchEvents(query(`q=${"ab".repeat(10)}`)).events.length, 0);
    const [event] = reader.searchEvents(query("q=big.log")).events;
    assert.deepEqual(event.outputStoredSeparately, { originalSize: 91234 });
    assert.equal(event.toolOutput, null);
    assert.ok(!JSON.stringify(event).includes("_blob_ref"));
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("no search row carries metadata_json or transcriptPath", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1", { transcriptPath: "C:\\Users\\dev\\.claude\\projects\\p\\s1.jsonl" });
    a.seedEvents("s1", 3);
    const body = JSON.stringify(reader.searchEvents(query("agent=claude-code")));
    assert.ok(!body.includes("transcriptPath"));
    assert.ok(!body.includes("metadata"));
    assert.ok(!body.includes(".jsonl"));
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("text that is only in the session metadata is not matched", () => {
  const a = createAuditDb();
  const reader = new AuditReader(a.dir);
  try {
    a.seedSession("s1", {
      metadataJson: JSON.stringify({ transcriptPath: "/home/dev/.claude/meta-only-marker.jsonl" }),
    });
    a.seedEvents("s1", 3);
    assert.deepEqual(reader.searchEvents(query("q=meta-only-marker")), { events: [], nextBefore: null });
  } finally {
    reader.close();
    a.cleanup();
  }
});

test("a project without an audit database finds nothing", () => {
  const a = createAuditDb();
  a.cleanup();
  const reader = new AuditReader(a.dir);
  assert.deepEqual(reader.searchEvents(query("q=anything")), { events: [], nextBefore: null });
});
