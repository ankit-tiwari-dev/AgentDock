import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync } from "node:fs";
import { ClaudeProvider } from "../src/claude-provider.ts";
import { SupervisorError } from "../src/supervisor-provider.ts";

const KEY = `sk-ant-api03-${"K7m2".repeat(12)}`;
const REVIEW = { summary: "One change", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] };

type Reply =
  { kind: "answer"; text: string; stopReason?: string } | { kind: "status"; status: number } | { kind: "hang" };

interface Seen {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

function sse(res: ServerResponse, text: string, stopReason: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  });
  if (stopReason !== "refusal") {
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 5 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

/** A stand-in for the Anthropic API on 127.0.0.1. Error bodies echo the key, as a careless proxy might. */
async function withFakeApi(replies: Reply[], fn: (baseURL: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      if (req.url?.startsWith("/v1/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            data: [{ id: "claude-opus-5-5", type: "model", display_name: "Opus", created_at: "2026-01-01T00:00:00Z" }],
            has_more: false,
            first_id: "claude-opus-5-5",
            last_id: "claude-opus-5-5",
          }),
        );
        return;
      }
      const reply = replies.shift() ?? { kind: "status", status: 500 };
      if (reply.kind === "hang") return;
      if (reply.kind === "status") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `bad request for key ${KEY}` } }));
        return;
      }
      sse(res, reply.text, reply.stopReason ?? "end_turn");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const ctx = (context = "GIT DIFF HEAD:\n+x", signal = new AbortController().signal) => ({
  projectPath: "",
  model: "claude-opus-5-5",
  signal,
  context,
});
const provider = (baseURL: string, timeoutMs = 10_000) =>
  new ClaudeProvider({ apiKey: KEY, model: "claude-opus-5-5", baseURL, timeoutMs });

test("no backend source file imports the Anthropic SDK at load time", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders = readdirSync(dir).filter(
    (f) =>
      f.endsWith(".ts") &&
      /^\s*import\s+(?!type\b)[^(]*from\s+["']@anthropic-ai\/sdk/m.test(readFileSync(new URL(f, dir), "utf8")),
  );
  assert.deepEqual(offenders, []);
});

test("the request names the model, the schema as output format and effort medium for questions and high for review", async () => {
  const questions = { isRefined: false, clarificationQuestions: [] };
  const saved = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "env-token-must-not-be-sent";
  try {
    await withFakeApi(
      [
        { kind: "answer", text: JSON.stringify(questions) },
        { kind: "answer", text: JSON.stringify(REVIEW) },
      ],
      async (baseURL, seen) => {
        const p = provider(baseURL);
        assert.deepEqual(await p.interview("Add login", undefined, ctx("FEATURE REQUEST:\nAdd login")), questions);
        assert.deepEqual(await p.review(ctx()), REVIEW);
        const [q, r] = seen;
        assert.equal(q.path, "/v1/messages");
        assert.equal(q.body.model, "claude-opus-5-5");
        assert.equal(q.body.stream, true);
        assert.deepEqual((q.body.output_config as { effort: string }).effort, "medium");
        assert.deepEqual((r.body.output_config as { effort: string }).effort, "high");
        assert.equal((q.body.output_config as { format: { type: string } }).format.type, "json_schema");
        assert.deepEqual(q.body.messages, [{ role: "user", content: "FEATURE REQUEST:\nAdd login" }]);
        assert.equal("thinking" in q.body, false);
        assert.equal(q.body.fallbacks, "default");
        assert.match(String(q.headers["anthropic-beta"]), /server-side-fallback-2026-07-01/);
        // API version 2026-10-21 sends the key as a bearer token; the environment token must not replace it.
        assert.equal(q.headers.authorization, `Bearer ${KEY}`);
        assert.equal(q.headers["x-api-key"], undefined);
      },
    );
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = saved;
  }
});

test("a model without server-side fallback gets no fallbacks field", async () => {
  await withFakeApi([{ kind: "answer", text: JSON.stringify(REVIEW) }], async (baseURL, seen) => {
    await new ClaudeProvider({ apiKey: KEY, model: "claude-haiku-5-5", baseURL, timeoutMs: 10_000 }).review({
      ...ctx(),
      model: "claude-haiku-5-5",
    });
    assert.equal("fallbacks" in seen[0].body, false);
    assert.equal(seen[0].headers["anthropic-beta"], undefined);
  });
});

test("a refusal is checked before content and gives REFUSED", async () => {
  await withFakeApi([{ kind: "answer", text: "", stopReason: "refusal" }], async (baseURL) => {
    await assert.rejects(provider(baseURL).review(ctx()), { code: "REFUSED" });
  });
});

test("an answer that breaks the schema or is cut off gives INVALID_ANSWER", async () => {
  await withFakeApi(
    [
      { kind: "answer", text: JSON.stringify({ ...REVIEW, extra: true }) },
      { kind: "answer", text: '{"summary": "cut', stopReason: "max_tokens" },
    ],
    async (baseURL) => {
      await assert.rejects(provider(baseURL).review(ctx()), { code: "INVALID_ANSWER" });
      await assert.rejects(provider(baseURL).review(ctx()), { code: "INVALID_ANSWER" });
    },
  );
});

test("regression: no automatic retry, a 429 or 500 is one call, and the key in the body never reaches the error", async () => {
  for (const [status, code] of [
    [401, "KEY_REJECTED"],
    [403, "KEY_REJECTED"],
    [404, "MODEL_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_ERROR"],
  ] as const) {
    await withFakeApi([{ kind: "status", status }], async (baseURL, seen) => {
      await assert.rejects(provider(baseURL).review(ctx()), (err: unknown) => {
        assert.ok(err instanceof SupervisorError);
        assert.equal(err.code, code, String(status));
        assert.equal(JSON.stringify(err.body()).includes(KEY), false);
        assert.equal((err.detail ?? "").includes(KEY), false);
        return true;
      });
      assert.equal(seen.length, 1, `${status} was retried`);
    });
  }
});

test("a run that does not answer in time is aborted and gives TIMEOUT", async () => {
  await withFakeApi([{ kind: "hang" }, { kind: "hang" }], async (baseURL) => {
    await assert.rejects(provider(baseURL, 300).review(ctx()), { code: "TIMEOUT" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(provider(baseURL).review(ctx(undefined, controller.signal)), { code: "TIMEOUT" });
  });
});

test("nothing listens there: UNREACHABLE", async () => {
  await assert.rejects(provider("http://127.0.0.1:9").review(ctx()), { code: "UNREACHABLE" });
});

test("the models list returns the ids the key can use", async () => {
  await withFakeApi([], async (baseURL, seen) => {
    assert.deepEqual(await provider(baseURL).listModels(), ["claude-opus-5-5"]);
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });
});
