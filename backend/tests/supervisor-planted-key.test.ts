import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { CLAUDE_KEY, KEYS, LOCAL_KEY, PROVIDERS, withApiBackend, type Mode } from "./supervisor-api-harness.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === ".git") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** The real dashboard when `make build` has run (local `make ci`); CI's test job does not build it, so a stub. */
const BUILT = join(import.meta.dirname, "..", "..", "frontend", "out");

function stubExport(): string {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-out-"));
  mkdirSync(join(dir, "_next"));
  writeFileSync(
    join(dir, "index.html"),
    `<!DOCTYPE html><html><head><script src="/_next/app.js"></script></head></html>`,
  );
  writeFileSync(join(dir, "_next", "app.js"), "console.log(1)");
  return dir;
}

const FAILURES: Array<[Mode, string]> = [
  [{ status: 401 }, "KEY_REJECTED"],
  [{ status: 403 }, "KEY_REJECTED"],
  [{ status: 404 }, "MODEL_NOT_FOUND"],
  [{ status: 429 }, "RATE_LIMITED"],
  [{ status: 500 }, "PROVIDER_ERROR"],
  ["refusal", "REFUSED"],
  ["garbage", "INVALID_ANSWER"],
  ["hang", "TIMEOUT"],
];

test("regression: a planted key appears in no file, log line, API response or served page", async () => {
  const bodies: string[] = [];
  const keep = (json: unknown) => bodies.push(JSON.stringify(json));
  let searched: string[] = [];
  const staticRoot = existsSync(join(BUILT, "index.html")) ? BUILT : stubExport();
  const get = async (base: string, path: string) => (await fetch(`${base}${path}`)).json();
  await withApiBackend({ keys: KEYS, timeoutMs: 1_500, staticRoot }, async ({ base, dirs, fake, logs, use, post }) => {
    // Before supervisor.json exists the settings write is refused; a key in the body changes nothing either.
    keep(await get(base, "/api/supervisor/settings"));
    const notConfigured = await post("/api/supervisor/settings", { provider: "claude", model: "claude-opus-5-5" });
    assert.equal(notConfigured.json.code, "NOT_CONFIGURED");
    keep(notConfigured.json);
    for (const provider of PROVIDERS) {
      use(provider);
      fake.setMode("ok");
      keep((await post("/api/supervisor/interview", { featurePrompt: "Add login" })).json);
      keep(
        (await post("/api/supervisor/interview", { featurePrompt: "Add login", developerAnswers: { q1: "Google" } }))
          .json,
      );
      keep((await post("/api/reviewer/explain", {}, 1)).json);
      keep(await get(base, "/api/health"));
      keep(await get(base, "/api/supervisor/settings"));
      keep(await get(base, `/api/supervisor/models?provider=${provider}`));
      const model = provider === "claude" ? "claude-sonnet-5-5" : "llama3.2";
      const saved = await post("/api/supervisor/settings", { provider, model });
      assert.equal(saved.status, 200, provider);
      keep(saved.json);
      const sneaky = await post("/api/supervisor/settings", { provider, model, apiKey: KEYS[provider] });
      assert.equal(sneaky.json.code, "UNKNOWN_FIELD");
      keep(sneaky.json);
      use(provider);
      for (const [mode, code] of FAILURES) {
        fake.setMode(mode);
        const res = await post("/api/reviewer/explain", {});
        assert.equal(res.json.code, code, `${provider} ${JSON.stringify(mode)}`);
        keep(res.json);
        if (typeof mode === "object") {
          const models = await get(base, `/api/supervisor/models?provider=${provider}`);
          assert.equal((models as { code?: string }).code, code, `models ${provider} ${mode.status}`);
          keep(models);
        }
      }
    }
    // Codex has no saved key; this one prints a key on stderr and fails.
    use("codex");
    const codex = await post("/api/reviewer/explain", {});
    assert.equal(codex.json.code, "CODEX_FAILED");
    keep(codex.json);
    keep(logs);
    assert.equal(logs.length, 2 * (3 + FAILURES.length) + 1);
    // Every page and script the backend serves.
    for (const file of [
      "/",
      ...filesUnder(staticRoot).map((f) => `/${relative(staticRoot, f).split(sep).join("/")}`),
    ]) {
      const res = await fetch(`${base}${file}`);
      bodies.push(await res.text());
    }
    searched = dirs.flatMap(filesUnder);
    for (const file of searched) {
      const bytes = readFileSync(file);
      for (const key of [CLAUDE_KEY, LOCAL_KEY]) {
        assert.equal(bytes.includes(key), false, `${key.slice(0, 6)} found in ${file}`);
      }
    }
  });
  if (staticRoot !== BUILT) rmSync(staticRoot, { recursive: true, force: true });
  assert.ok(searched.some((f) => f.endsWith("supervisor.json")));
  const all = bodies.join("\n");
  assert.equal(all.includes(CLAUDE_KEY), false, "Claude key in a response, log line or page");
  assert.equal(all.includes(LOCAL_KEY), false, "local key in a response, log line or page");
  assert.match(all, /PROVIDER_KEY/, "the exact-key removal never ran");
  assert.match(all, /<html/i, "no page was served");
});
