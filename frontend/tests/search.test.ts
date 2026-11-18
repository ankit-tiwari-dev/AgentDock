import test from "node:test";
import assert from "node:assert/strict";
import { type PublicEvent, pageFromHash, PAGES } from "../src/lib/events.ts";
import {
  EMPTY_SEARCH,
  appendPage,
  isStale,
  newestRowId,
  parseSearchHash,
  searchError,
  searchHash,
  searchUrl,
  timelineStart,
  timelineUrl,
} from "../src/lib/search.ts";

const hit = (id: string, rowId: number, over: Partial<PublicEvent> = {}): PublicEvent => ({
  id,
  rowId,
  sequenceNum: rowId,
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

test("#sessions?q=…&agent=… opens Sessions with the same query and filters", () => {
  const hash = "#sessions?q=npm%20install&agent=claude-code&verdict=DENY&tool=Bash&from=2026-11-01&to=2026-11-18";
  assert.equal(pageFromHash(hash), "sessions");
  assert.deepEqual(parseSearchHash(hash), {
    q: "npm install",
    agent: "claude-code",
    verdict: "DENY",
    tool: "Bash",
    from: "2026-11-01",
    to: "2026-11-18",
  });
});

test("writing then reading the hash gives the same state, and an empty search writes plain #sessions", () => {
  const state = { ...EMPTY_SEARCH, q: "C:\\Users\\dev & 50%", verdict: "REQUIRE_MANUAL_APPROVAL", from: "2026-11-01" };
  assert.deepEqual(parseSearchHash(searchHash(state)), state);
  assert.equal(searchHash(EMPTY_SEARCH), "#sessions");
  assert.equal(parseSearchHash("#sessions"), null);
  assert.equal(parseSearchHash("#overview?q=npm"), null);
});

test("every existing page hash still opens its page, and unknown values in the hash are dropped", () => {
  for (const page of PAGES) assert.equal(pageFromHash(`#${page}`), page);
  assert.equal(pageFromHash("#nope?q=x"), "overview");
  assert.deepEqual(parseSearchHash("#sessions?q=ab&agent=robot&verdict=MAYBE&from=yesterday"), {
    ...EMPTY_SEARCH,
    q: "ab",
  });
});

test("the browser checks a too-short query and a reversed date range before asking the server", () => {
  assert.equal(searchError({ ...EMPTY_SEARCH, q: "a" }), "Type at least 2 characters.");
  assert.equal(searchError({ ...EMPTY_SEARCH, q: "  a " }), "Type at least 2 characters.");
  assert.equal(searchError({ ...EMPTY_SEARCH, from: "2026-11-18", to: "2026-11-17" }), "From must be before To.");
  assert.equal(searchError({ ...EMPTY_SEARCH, from: "2026-11-18", to: "2026-11-18" }), null);
  assert.equal(searchError({ ...EMPTY_SEARCH, q: "ab" }), null);
});

test("the search URL names the project, sends dates as local-midnight milliseconds with To covering its whole day, and the page cursor", () => {
  const url = new URL(
    searchUrl("my proj", { ...EMPTY_SEARCH, q: " npm ", tool: "Bash", from: "2026-11-01", to: "2026-11-01" }, 41),
    "http://x",
  );
  assert.equal(url.pathname, "/api/events/search");
  assert.equal(url.searchParams.get("project"), "my proj");
  assert.equal(url.searchParams.get("q"), "npm");
  assert.equal(url.searchParams.get("tool"), "Bash");
  assert.equal(url.searchParams.get("from"), String(new Date(2026, 10, 1).getTime()));
  assert.equal(url.searchParams.get("to"), String(new Date(2026, 10, 2).getTime()));
  assert.equal(url.searchParams.get("before"), "41");
  assert.equal(url.searchParams.has("agent"), false);
  const plain = new URL(searchUrl(null, { ...EMPTY_SEARCH, q: "ab" }), "http://x");
  assert.equal(plain.searchParams.has("project"), false);
  assert.equal(plain.searchParams.has("before"), false);
});

test("the timeline URL encodes the session id and carries both parts of the cursor", () => {
  const url = new URL(timelineUrl("p1", "a/b c", { sequenceNum: 9, rowId: 120 }), "http://x");
  assert.equal(url.pathname, "/api/sessions/a%2Fb%20c/timeline");
  assert.equal(url.searchParams.get("project"), "p1");
  assert.equal(url.searchParams.get("after"), "9");
  assert.equal(url.searchParams.get("afterRow"), "120");
  const first = new URL(timelineUrl(null, "s1"), "http://x");
  assert.equal(first.search, "");
});

test("opening a search result starts the timeline at that event, and the start is never before 0", () => {
  assert.deepEqual(timelineStart(hit("e", 50, { sequenceNum: 12 })), { after: 11 });
  assert.deepEqual(timelineStart(hit("e", 50, { sequenceNum: 0 })), { after: 0 });
  assert.equal(new URL(timelineUrl(null, "s1", { after: 11 }), "http://x").searchParams.get("after"), "11");
});

test("Load more appends the next page without repeats and hides at the end", () => {
  const first = appendPage([], { events: [hit("a", 9), hit("b", 8)], next: 8 });
  assert.deepEqual(
    first.events.map((e) => e.id),
    ["a", "b"],
  );
  assert.equal(first.hasMore, true);
  const second = appendPage(first.events, { events: [hit("b", 8), hit("c", 7)], next: null });
  assert.deepEqual(
    second.events.map((e) => e.id),
    ["a", "b", "c"],
  );
  assert.equal(second.hasMore, false);
});

test("the New events note appears only when the snapshot gains a newer event after the search", () => {
  const before = [hit("a", 20), hit("b", 19)];
  const seen = newestRowId(before);
  assert.equal(seen, 20);
  assert.equal(isStale(seen, before), false);
  assert.equal(isStale(seen, [hit("b", 19)]), false);
  assert.equal(isStale(seen, [hit("c", 21), ...before]), true);
  assert.equal(isStale(null, [hit("c", 21)]), false);
  assert.equal(newestRowId([]), 0);
  assert.equal(isStale(0, [hit("c", 1)]), true);
});
