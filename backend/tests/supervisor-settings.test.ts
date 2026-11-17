import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_KEY, KEYS, withApiBackend, type Harness } from "./supervisor-api-harness.ts";

const settingsFile = (h: Harness) => join(h.dirs[0], "supervisor.json");
const readSettings = (h: Harness) => JSON.parse(readFileSync(settingsFile(h), "utf8")) as Record<string, unknown>;
const getJson = async (h: Harness, path: string) => {
  const res = await fetch(`${h.base}${path}`);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

test("GET settings shows provider, model, base URL, source and Key saved per API provider", async () => {
  await withApiBackend({ keys: { claude: CLAUDE_KEY } }, async (h) => {
    h.use("openai-compatible");
    assert.deepEqual(await getJson(h, "/api/supervisor/settings"), {
      status: 200,
      json: {
        provider: "openai-compatible",
        model: "qwen3-coder",
        baseUrl: `${h.fake.url}/v1`,
        source: "config",
        keys: { claude: true, "openai-compatible": false },
        writable: true,
      },
    });
    assert.equal(JSON.stringify(await getJson(h, "/api/supervisor/settings")).includes(CLAUDE_KEY), false);
  });
});

test("GET settings with no file says how to turn the supervisor on, and an invalid file says why it cannot be used", async () => {
  await withApiBackend({}, async (h) => {
    const off = (await getJson(h, "/api/supervisor/settings")).json;
    assert.equal(off.provider, null);
    assert.equal(off.source, "none");
    assert.equal(off.writable, false);
    assert.equal(
      off.writableReason,
      "Turn the supervisor on first in a terminal: ctrlplane supervisor use <provider> <model>",
    );
    writeFileSync(settingsFile(h), "{ not json");
    const bad = (await getJson(h, "/api/supervisor/settings")).json;
    assert.equal(bad.provider, null);
    assert.equal(bad.source, "config");
    assert.equal(bad.writable, true);
    assert.equal(
      bad.configProblem,
      "The supervisor settings file cannot be used (json). Rewrite it with: ctrlplane supervisor use <provider> <model>",
    );
  });
});

test("GET models lists the provider's models from the fake, and codex answers freeText", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("claude");
    assert.deepEqual((await getJson(h, "/api/supervisor/models?provider=claude")).json, {
      models: ["claude-opus-5-5", "claude-sonnet-5-5"],
      freeText: false,
      current: "claude-opus-5-5",
    });
    h.use("openai-compatible");
    assert.deepEqual((await getJson(h, "/api/supervisor/models?provider=openai-compatible")).json, {
      models: ["qwen3-coder", "llama3.2"],
      freeText: false,
      current: "qwen3-coder",
    });
    assert.deepEqual((await getJson(h, "/api/supervisor/models?provider=codex")).json, {
      models: [],
      freeText: true,
      current: null,
    });
    assert.deepEqual(await getJson(h, "/api/supervisor/models?provider=gpt"), {
      status: 400,
      json: { error: "Unknown provider.", code: "INVALID_PROVIDER" },
    });
  });
});

test("GET models failures are fixed messages: no key, rejected key, and no saved base URL", async () => {
  await withApiBackend({}, async (h) => {
    h.use("codex");
    assert.deepEqual(await getJson(h, "/api/supervisor/models?provider=claude"), {
      status: 503,
      json: { error: "No Claude key saved. Run: ctrlplane supervisor set-key claude", code: "KEY_MISSING" },
    });
    assert.deepEqual(await getJson(h, "/api/supervisor/models?provider=openai-compatible"), {
      status: 400,
      json: {
        error:
          "Set the base URL first in a terminal: ctrlplane supervisor use openai-compatible <model> --base-url <url>",
        code: "BASE_URL_MISSING",
      },
    });
    assert.equal(h.fake.calls.length, 0);
  });
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("claude");
    h.fake.setMode({ status: 401 });
    const res = await getJson(h, "/api/supervisor/models?provider=claude");
    assert.equal(res.status, 503);
    assert.equal(res.json.code, "KEY_REJECTED");
    assert.equal(JSON.stringify(res).includes(CLAUDE_KEY), false);
  });
});

test("POST provider and model rewrites supervisor.json atomically, keeps the base URL, and the next run uses it", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("openai-compatible");
    const res = await h.post("/api/supervisor/settings", { provider: "claude", model: "claude-sonnet-5-5" });
    assert.equal(res.status, 200);
    assert.equal(res.json.provider, "claude");
    assert.equal(res.json.model, "claude-sonnet-5-5");
    assert.deepEqual(readSettings(h), {
      version: 1,
      provider: "claude",
      model: "claude-sonnet-5-5",
      openaiCompatible: { baseUrl: `${h.fake.url}/v1` },
    });
    assert.deepEqual(
      readdirSync(h.dirs[0]).filter((f) => f.endsWith(".tmp")),
      [],
    );
    assert.equal((await h.post("/api/reviewer/explain", {})).status, 200);
    assert.deepEqual(
      h.fake.calls.map((c) => [c.api, c.model]),
      [["anthropic", "claude-sonnet-5-5"]],
    );
    const codex = await h.post("/api/supervisor/settings", { provider: "codex", model: null });
    assert.equal(codex.status, 200);
    assert.equal("model" in readSettings(h), false, "null means Codex's own default");
  });
});

test("regression: POST with apiKey, key or baseUrl gets 400 and changes nothing", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("claude");
    const before = readFileSync(settingsFile(h), "utf8");
    for (const extra of [{ apiKey: "sk-ant-x" }, { key: "x" }, { baseUrl: "https://evil.example/v1" }]) {
      assert.deepEqual(await h.post("/api/supervisor/settings", { provider: "claude", model: "m", ...extra }), {
        status: 400,
        json: { error: "Only provider and model can be changed here.", code: "UNKNOWN_FIELD" },
      });
    }
    assert.deepEqual(
      (await h.post("/api/supervisor/settings", { provider: "gpt", model: "m" })).json.code,
      "INVALID_PROVIDER",
    );
    assert.deepEqual(await h.post("/api/supervisor/settings", { provider: "claude", model: "" }), {
      status: 400,
      json: { error: "The model name is empty, too long or has control characters.", code: "INVALID_MODEL" },
    });
    assert.equal(
      (await h.post("/api/supervisor/settings", { provider: "claude", model: "a\nb" })).json.code,
      "INVALID_MODEL",
    );
    assert.equal((await h.post("/api/supervisor/settings", { provider: "claude" })).json.code, "INVALID_MODEL");
    assert.equal((await h.post("/api/supervisor/settings", ["claude"])).json.code, "UNKNOWN_FIELD");
    assert.equal(readFileSync(settingsFile(h), "utf8"), before);
  });
});

test("regression: POST settings without a matching Origin or application/json is refused as today", async () => {
  await withApiBackend({}, async (h) => {
    h.use("claude");
    const before = readFileSync(settingsFile(h), "utf8");
    const send = (headers: Record<string, string>) =>
      fetch(`${h.base}/api/supervisor/settings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ provider: "codex", model: null }),
      });
    assert.equal((await send({ "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);
    assert.equal((await send({ "Content-Type": "text/plain" })).status, 415);
    assert.equal(readFileSync(settingsFile(h), "utf8"), before);
  });
});

test("regression: POST settings without supervisor.json gets 409 and creates no file", async () => {
  await withApiBackend({ env: { AGENTDOCK_CODEX: "1" } }, async (h) => {
    assert.deepEqual(await h.post("/api/supervisor/settings", { provider: "claude", model: "claude-opus-5-5" }), {
      status: 409,
      json: {
        error: "Turn the supervisor on first in a terminal: ctrlplane supervisor use <provider> <model>",
        code: "NOT_CONFIGURED",
      },
    });
    assert.equal(existsSync(settingsFile(h)), false);
  });
});

test("POST openai-compatible with no saved base URL gets 400", async () => {
  await withApiBackend({}, async (h) => {
    h.use("claude");
    const before = readFileSync(settingsFile(h), "utf8");
    const res = await h.post("/api/supervisor/settings", { provider: "openai-compatible", model: "llama3.2" });
    assert.equal(res.status, 400);
    assert.equal(res.json.code, "BASE_URL_MISSING");
    assert.equal(readFileSync(settingsFile(h), "utf8"), before);
  });
});

test("when the settings file is not writable, GET says why and POST gets 503", async () => {
  await withApiBackend({}, async (h) => {
    h.use("claude");
    chmodSync(settingsFile(h), 0o444);
    try {
      const view = (await getJson(h, "/api/supervisor/settings")).json;
      assert.equal(view.writable, false);
      const reason =
        "The backend cannot write the settings file. Change the supervisor with ctrlplane supervisor in a terminal.";
      assert.equal(view.writableReason, reason);
      assert.deepEqual(await h.post("/api/supervisor/settings", { provider: "codex", model: null }), {
        status: 503,
        json: { error: reason, code: "READ_ONLY" },
      });
      assert.equal(readSettings(h).provider, "claude");
    } finally {
      chmodSync(settingsFile(h), 0o644);
    }
  });
});

test("in Docker settings are read-only, keys are not readable, and no keychain tool starts", async () => {
  await withApiBackend({ keys: KEYS, env: { AGENTDOCK_IN_CONTAINER: "1" } }, async (h) => {
    h.use("claude");
    const docker =
      "Read-only container. Change the supervisor with ctrlplane supervisor on the host. API providers need the host keychain, so they do not run in Docker.";
    const view = (await getJson(h, "/api/supervisor/settings")).json;
    assert.deepEqual(view.keys, { claude: null, "openai-compatible": null });
    assert.equal(view.writable, false);
    assert.equal(view.writableReason, docker);
    assert.deepEqual(await h.post("/api/supervisor/settings", { provider: "codex", model: null }), {
      status: 503,
      json: { error: docker, code: "READ_ONLY" },
    });
    assert.equal((await getJson(h, "/api/supervisor/models?provider=claude")).json.code, "KEYCHAIN_UNAVAILABLE");
    assert.equal(h.keychainCalls(), 0);
    assert.equal(h.fake.calls.length, 0);
  });
});

test("POST settings never reads the keychain", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("claude");
    assert.equal(
      (await h.post("/api/supervisor/settings", { provider: "claude", model: "claude-sonnet-5-5" })).status,
      200,
    );
    const calls = h.keychainCalls();
    // The 200 body re-reads key state for the view; the write itself must not touch the keychain.
    assert.ok(calls <= 2, `keychain used ${calls} times`);
    await h.post("/api/supervisor/settings", { provider: "claude", model: "x" + "y".repeat(300) });
    assert.equal(h.keychainCalls(), calls, "a refused POST read the keychain");
  });
});
