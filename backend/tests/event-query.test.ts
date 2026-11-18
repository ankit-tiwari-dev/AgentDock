import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENT_TYPES,
  jsonEscapedText,
  likePattern,
  parseSearchQuery,
  parseTimelineQuery,
  QUERY_LIMITS,
} from "../src/event-query.ts";

const search = (qs: string) => parseSearchQuery(new URLSearchParams(qs));
const timeline = (qs: string) => parseTimelineQuery(new URLSearchParams(qs));

test("limit defaults to 50 for search and 200 for the timeline", () => {
  assert.deepEqual(search(""), {
    ok: true,
    value: { q: null, agent: null, verdict: null, tool: null, from: null, to: null, before: null, limit: 50 },
  });
  assert.deepEqual(timeline(""), { ok: true, value: { after: null, afterRow: null, limit: 200 } });
  assert.equal(QUERY_LIMITS.max, 200);
});

test("valid values are read and q is trimmed", () => {
  const parsed = search(
    "q=%20needle%20&agent=codex&verdict=DENY&tool=Bash&from=1000&to=2000&before=17&limit=200&unknown=x",
  );
  assert.deepEqual(parsed, {
    ok: true,
    value: { q: "needle", agent: "codex", verdict: "DENY", tool: "Bash", from: 1000, to: 2000, before: 17, limit: 200 },
  });
  assert.deepEqual(timeline("after=0&afterRow=5&limit=1"), { ok: true, value: { after: 0, afterRow: 5, limit: 1 } });
  assert.deepEqual(search("q=%20%20").ok && search("q=%20%20"), {
    ok: true,
    value: { q: null, agent: null, verdict: null, tool: null, from: null, to: null, before: null, limit: 50 },
  });
});

test("the agent list is the CLI's", () => {
  assert.deepEqual([...AGENT_TYPES], ["claude-code", "codex", "opencode", "cursor", "gemini", "custom"]);
});

test("bad values are QUERY_INVALID", () => {
  const bad = [
    "q=a",
    `q=${"x".repeat(201)}`,
    "agent=claude",
    "verdict=allow",
    "tool=",
    `tool=${"t".repeat(201)}`,
    "from=1e3",
    "from=-1",
    "to=1.5",
    "from=2000&to=2000",
    "from=3000&to=2000",
    `to=${"9".repeat(17)}`,
    "before=0",
    "before=abc",
    "limit=0",
    "limit=201",
    "limit=",
  ];
  for (const qs of bad) {
    const parsed = search(qs);
    assert.equal(parsed.ok, false, qs);
  }
  for (const qs of ["after=-1", "after=x", "afterRow=3", "after=1&afterRow=0", "limit=201", "limit=0"]) {
    assert.equal(timeline(qs).ok, false, qs);
  }
  assert.equal(search(`q=${"x".repeat(200)}`).ok, true);
  assert.equal(search("q=ab").ok, true);
});

test("the error text never repeats what the client sent", () => {
  const planted = "sk-ant-api03-PLANTED";
  for (const qs of [
    `q=${planted}${"x".repeat(200)}`,
    `agent=${planted}`,
    `verdict=${planted}`,
    `tool=${planted}${"t".repeat(200)}`,
    `from=${planted}`,
    `before=${planted}`,
    `limit=${planted}`,
  ]) {
    const parsed = search(qs);
    assert.equal(parsed.ok, false);
    if (!parsed.ok) assert.ok(!parsed.error.includes("PLANTED"), parsed.error);
  }
  const t = timeline(`after=${planted}`);
  assert.ok(!t.ok && !t.error.includes("PLANTED"));
});

test("% _ and backslash are escaped, and the JSON-escaped form doubles backslashes and escapes quotes", () => {
  assert.equal(likePattern("50%"), "%50\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
  assert.equal(likePattern("C:\\Users"), "%C:\\\\Users%");
  assert.equal(jsonEscapedText("C:\\Users"), "C:\\\\Users");
  assert.equal(jsonEscapedText('say "hi"'), 'say \\"hi\\"');
  assert.equal(jsonEscapedText("plain"), "plain");
});
