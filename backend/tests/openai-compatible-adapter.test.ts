import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import { OpenAICompatibleProvider, toStrictSchema } from "../src/openai-compatible-provider.ts";
import { SupervisorError } from "../src/supervisor-provider.ts";
import { supervisorSchema } from "../src/supervisor-schemas.ts";

const KEY = `local-${"q8Zr".repeat(10)}`;
const REVIEW = { summary: "One change", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] };

type Reply =
  | { kind: "answer"; content: string | null; refusal?: string; finish?: string }
  | { kind: "status"; status: number }
  | { kind: "redirect" }
  | { kind: "hang" };

interface Seen {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

async function withFakeServer(replies: Reply[], fn: (baseUrl: string, seen: Seen[]) => Promise<void>) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      seen.push({
        method: req.method ?? "",
        path: req.url ?? "",
        headers: req.headers,
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
      });
      if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3-coder" }, { id: "llama4" }] }));
        return;
      }
      const reply = replies.shift() ?? { kind: "status", status: 500 };
      if (reply.kind === "hang") return;
      if (reply.kind === "redirect") {
        res.writeHead(307, { location: "/v1/redirected" });
        res.end();
        return;
      }
      if (reply.kind === "status") {
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `rejected key ${KEY}` } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              index: 0,
              finish_reason: reply.finish ?? "stop",
              message: { role: "assistant", content: reply.content, refusal: reply.refusal ?? null },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}/v1`, seen);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const ctx = (signal = new AbortController().signal) => ({
  projectPath: "",
  model: "qwen3-coder",
  signal,
  context: "GIT DIFF HEAD:\n+x",
});
const provider = (baseUrl: string, apiKey: string | null = KEY, timeoutMs = 10_000) =>
  new OpenAICompatibleProvider({ baseUrl, apiKey, model: "qwen3-coder", timeoutMs });

test("the strict schema copy requires every field and makes the optional ones nullable", () => {
  const strict = toStrictSchema(supervisorSchema) as {
    required: string[];
    properties: Record<string, { type: unknown; items?: { required: string[] } }>;
  };
  assert.deepEqual(strict.required, ["isRefined", "clarificationQuestions", "lockedSpecification"]);
  assert.equal(strict.properties.isRefined.type, "boolean");
  assert.deepEqual(strict.properties.clarificationQuestions.type, ["array", "null"]);
  assert.deepEqual(strict.properties.lockedSpecification.type, ["object", "null"]);
  assert.deepEqual(strict.properties.clarificationQuestions.items?.required, [
    "id",
    "question",
    "whyItMatters",
    "suggestedAnswers",
  ]);
  assert.equal("type" in supervisorSchema.properties.lockedSpecification, true);
  assert.equal(supervisorSchema.properties.lockedSpecification.type, "object");
});

test("the request uses response_format json_schema and sends Authorization only when a key is saved", async () => {
  await withFakeServer(
    [
      { kind: "answer", content: JSON.stringify(REVIEW) },
      {
        kind: "answer",
        content: JSON.stringify({ isRefined: false, clarificationQuestions: [], lockedSpecification: null }),
      },
    ],
    async (baseUrl, seen) => {
      assert.deepEqual(await provider(baseUrl).review(ctx()), REVIEW);
      assert.deepEqual(await provider(baseUrl, null).interview("x", undefined, ctx()), {
        isRefined: false,
        clarificationQuestions: [],
      });
      const [withKey, withoutKey] = seen;
      assert.equal(withKey.path, "/v1/chat/completions");
      assert.equal(withKey.body.model, "qwen3-coder");
      const format = withKey.body.response_format as { type: string; json_schema: { strict: boolean; name: string } };
      assert.equal(format.type, "json_schema");
      assert.equal(format.json_schema.strict, true);
      assert.equal(format.json_schema.name, "review_result");
      assert.deepEqual((withKey.body.messages as Array<{ role: string; content: string }>).at(-1), {
        role: "user",
        content: "GIT DIFF HEAD:\n+x",
      });
      assert.equal(withKey.headers.authorization, `Bearer ${KEY}`);
      assert.equal(withoutKey.headers.authorization, undefined);
    },
  );
});

test("a 400 on response_format makes exactly one second call without it, with the schema in the prompt, and the answer is still validated", async () => {
  await withFakeServer(
    [
      { kind: "status", status: 400 },
      { kind: "answer", content: "```json\n" + JSON.stringify(REVIEW) + "\n```" },
      { kind: "status", status: 400 },
      { kind: "answer", content: JSON.stringify({ summary: "no other fields" }) },
    ],
    async (baseUrl, seen) => {
      assert.deepEqual(await provider(baseUrl).review(ctx()), REVIEW);
      assert.equal(seen.length, 2);
      assert.equal("response_format" in seen[1].body, false);
      const system = (seen[1].body.messages as Array<{ role: string; content: string }>)[0];
      assert.equal(system.role, "system");
      assert.match(system.content, /^Answer with one JSON object that matches this JSON Schema: \{/);
      await assert.rejects(provider(baseUrl).review(ctx()), { code: "INVALID_ANSWER" });
      assert.equal(seen.length, 4);
    },
  );
});

test("regression: every failure is a fixed code and the key the server echoes never reaches the error", async () => {
  for (const [status, code] of [
    [401, "KEY_REJECTED"],
    [403, "KEY_REJECTED"],
    [404, "MODEL_NOT_FOUND"],
    [429, "RATE_LIMITED"],
    [500, "PROVIDER_ERROR"],
  ] as const) {
    await withFakeServer([{ kind: "status", status }], async (baseUrl, seen) => {
      await assert.rejects(provider(baseUrl).review(ctx()), (err: unknown) => {
        assert.ok(err instanceof SupervisorError);
        assert.equal(err.code, code, String(status));
        assert.equal(JSON.stringify(err.body()).includes(KEY), false);
        assert.equal((err.detail ?? "").includes(KEY), false);
        assert.match(err.detail ?? "", /PROVIDER_KEY/);
        return true;
      });
      assert.equal(seen.length, 1);
    });
  }
});

test("a refusal gives REFUSED and a cut-off answer gives INVALID_ANSWER", async () => {
  await withFakeServer(
    [
      { kind: "answer", content: null, refusal: "I can't help with that." },
      { kind: "answer", content: '{"summary": "cut', finish: "length" },
    ],
    async (baseUrl) => {
      await assert.rejects(provider(baseUrl).review(ctx()), { code: "REFUSED" });
      await assert.rejects(provider(baseUrl).review(ctx()), { code: "INVALID_ANSWER" });
    },
  );
});

test("regression: a redirect is not followed, so the key never goes to a second address", async () => {
  await withFakeServer([{ kind: "redirect" }], async (baseUrl, seen) => {
    await assert.rejects(provider(baseUrl).review(ctx()), { code: "UNREACHABLE" });
    assert.deepEqual(
      seen.map((s) => s.path),
      ["/v1/chat/completions"],
    );
  });
});

test("a server that does not answer in time gives TIMEOUT, and so does the run being stopped", async () => {
  await withFakeServer([{ kind: "hang" }, { kind: "hang" }], async (baseUrl) => {
    await assert.rejects(provider(baseUrl, KEY, 300).review(ctx()), { code: "TIMEOUT" });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const started = Date.now();
    await assert.rejects(provider(baseUrl).review(ctx(controller.signal)), { code: "TIMEOUT" });
    assert.ok(Date.now() - started < 3_000, "the stopped run kept waiting for its own timeout");
  });
  await assert.rejects(provider("http://127.0.0.1:9/v1").review(ctx()), { code: "UNREACHABLE" });
});

test("the models list returns the server's model ids", async () => {
  await withFakeServer([], async (baseUrl, seen) => {
    assert.deepEqual(await provider(baseUrl).listModels(), ["qwen3-coder", "llama4"]);
    assert.equal(seen[0].path, "/v1/models");
    assert.equal(seen[0].headers.authorization, `Bearer ${KEY}`);
  });
});
