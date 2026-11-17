import test from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_KEY, KEYS, LOCAL_KEY, PLAN, PROVIDERS, QUESTIONS, withApiBackend } from "./supervisor-api-harness.ts";

test("each provider returns questions and then a final plan valid against supervisorSchema", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, logs }) => {
    for (const provider of PROVIDERS) {
      use(provider);
      const first = await post("/api/supervisor/interview", { featurePrompt: "Add Google login" });
      assert.equal(first.status, 200, provider);
      assert.deepEqual(first.json.clarificationQuestions, QUESTIONS.clarificationQuestions);
      const final = await post("/api/supervisor/interview", {
        featurePrompt: "Add Google login",
        developerAnswers: { q1: "Google" },
      });
      assert.equal(final.status, 200, provider);
      assert.deepEqual(final.json.lockedSpecification, PLAN.lockedSpecification);
    }
    assert.deepEqual(
      logs.map((l) => [l.provider, l.mode, l.outcome]),
      [
        ["claude", "questions", "ok"],
        ["claude", "finalize", "ok"],
        ["openai-compatible", "questions", "ok"],
        ["openai-compatible", "finalize", "ok"],
      ],
    );
    assert.ok(logs.every((l) => typeof l.context_bytes === "number" && l.context_bytes > 0));
  });
});

test("each provider explains the picked project's changes, not the first project's", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake }) => {
    for (const provider of PROVIDERS) {
      use(provider);
      const res = await post("/api/reviewer/explain", {}, 1);
      assert.equal(res.status, 200, provider);
      assert.equal(res.json.summary, "explained");
      const sent = fake.calls.at(-1)!.context;
      assert.match(sent, /BRAVO-CHANGE/);
      assert.doesNotMatch(sent, /ALPHA/);
    }
  });
});

test("switching provider with the CLI applies to the next run without a restart", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake }) => {
    use("claude");
    assert.equal((await post("/api/reviewer/explain", {})).status, 200);
    use("openai-compatible");
    assert.equal((await post("/api/reviewer/explain", {})).status, 200);
    assert.deepEqual(
      fake.calls.map((c) => c.api),
      ["anthropic", "openai"],
    );
  });
});

test("with no saved key no network call is made and the message names set-key", async () => {
  await withApiBackend({}, async ({ use, post, fake, logs }) => {
    use("claude");
    assert.deepEqual(await post("/api/reviewer/explain", {}), {
      status: 503,
      json: { error: "No Claude key saved. Run: ctrlplane supervisor set-key claude", code: "KEY_MISSING" },
    });
    assert.equal(fake.calls.length, 0);
    assert.equal(logs[0].outcome, "KEY_MISSING");
    // A local server may need no key, so openai-compatible runs without one.
    use("openai-compatible");
    assert.equal((await post("/api/reviewer/explain", {})).status, 200);
  });
});

test("regression: every provider failure reaches the browser as its fixed message and code, never the raw body", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake, logs }) => {
    fake.setMode({ status: 401 });
    for (const provider of PROVIDERS) {
      use(provider);
      const res = await post("/api/reviewer/explain", {});
      const label = provider === "claude" ? "Claude" : "OpenAI-compatible";
      assert.deepEqual(res, {
        status: 503,
        json: {
          error: `The ${label} key was rejected. Save a new one with: ctrlplane supervisor set-key ${provider}`,
          code: "KEY_REJECTED",
        },
      });
    }
    const logged = JSON.stringify(logs);
    assert.equal(logged.includes(CLAUDE_KEY), false);
    assert.equal(logged.includes(LOCAL_KEY), false);
  });
});

test("an oversized explain sends nothing", async () => {
  await withApiBackend({ keys: KEYS, big: true }, async ({ use, post, fake, logs }) => {
    use("claude");
    const res = await post("/api/reviewer/explain", {}, 1);
    assert.equal(res.status, 503);
    assert.equal(res.json.code, "CONTEXT_TOO_LARGE");
    assert.match(String(res.json.error), /^The changes are \d+ KB; the limit is 200 KB\./);
    assert.equal(fake.calls.length, 0);
    assert.equal(logs[0].outcome, "CONTEXT_TOO_LARGE");
  });
});

test("the one-run lock covers every provider and is released after an error and after a timeout", async () => {
  await withApiBackend({ keys: KEYS, timeoutMs: 1_500 }, async ({ use, post, fake }) => {
    for (const provider of PROVIDERS) {
      use(provider);
      fake.setMode("hang");
      const before = fake.calls.length;
      const first = post("/api/reviewer/explain", {});
      while (fake.calls.length === before) await new Promise((r) => setTimeout(r, 20));
      const second = await post("/api/supervisor/interview", { featurePrompt: "x" }, 1);
      assert.equal(second.status, 409, provider);
      assert.equal(second.json.code, "BUSY");
      assert.equal((await first).json.code, "TIMEOUT", provider);
      fake.setMode({ status: 500 });
      assert.equal((await post("/api/reviewer/explain", {})).json.code, "PROVIDER_ERROR");
      fake.setMode("ok");
      assert.equal((await post("/api/reviewer/explain", {})).status, 200, `${provider} lock not released`);
    }
  });
});

test("in Docker the API providers stop with KEYCHAIN_UNAVAILABLE and never start a keychain tool", async () => {
  await withApiBackend(
    { keys: KEYS, env: { AGENTDOCK_IN_CONTAINER: "1" } },
    async ({ base, use, post, fake, keychainCalls }) => {
      use("claude");
      assert.deepEqual(await post("/api/reviewer/explain", {}), {
        status: 503,
        json: {
          error: "API providers need the host keychain, so they do not run in Docker.",
          code: "KEYCHAIN_UNAVAILABLE",
        },
      });
      const health = (await (await fetch(`${base}/api/health`)).json()) as { supervisor: unknown };
      assert.deepEqual(health.supervisor, {
        provider: "claude",
        model: "claude-opus-5-5",
        keySaved: null,
        ready: false,
      });
      assert.equal(keychainCalls(), 0);
      assert.equal(fake.calls.length, 0);
    },
  );
});

test("health says whether the key is saved and whether a click would start a run, and never holds the key", async () => {
  const health = async (base: string) =>
    (await (await fetch(`${base}/api/health`)).json()) as { codexEnabled: boolean; supervisor: unknown };
  await withApiBackend({ keys: { claude: CLAUDE_KEY } }, async ({ base, use, keychainCalls }) => {
    use("claude");
    const h = await health(base);
    assert.equal(h.codexEnabled, false);
    assert.deepEqual(h.supervisor, { provider: "claude", model: "claude-opus-5-5", keySaved: true, ready: true });
    assert.equal(JSON.stringify(h).includes(CLAUDE_KEY), false);
    await health(base);
    assert.equal(keychainCalls(), 1, "the 30 second cache was not used");
    use("openai-compatible");
    assert.deepEqual((await health(base)).supervisor, {
      provider: "openai-compatible",
      model: "qwen3-coder",
      keySaved: false,
      ready: true,
    });
  });
  await withApiBackend({}, async ({ base, use }) => {
    use("claude");
    assert.deepEqual((await health(base)).supervisor, {
      provider: "claude",
      model: "claude-opus-5-5",
      keySaved: false,
      ready: false,
    });
  });
});
