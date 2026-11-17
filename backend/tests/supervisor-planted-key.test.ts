import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_KEY, KEYS, LOCAL_KEY, PROVIDERS, withApiBackend, type Mode } from "./supervisor-api-harness.ts";

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === ".git") return [];
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
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

test("regression: a planted key appears in no file, log line or API response", async () => {
  const bodies: string[] = [];
  const keep = (json: unknown) => bodies.push(JSON.stringify(json));
  let searched: string[] = [];
  await withApiBackend({ keys: KEYS, timeoutMs: 1_500 }, async ({ base, dirs, fake, logs, use, post }) => {
    for (const provider of PROVIDERS) {
      use(provider);
      fake.setMode("ok");
      keep((await post("/api/supervisor/interview", { featurePrompt: "Add login" })).json);
      keep(
        (await post("/api/supervisor/interview", { featurePrompt: "Add login", developerAnswers: { q1: "Google" } }))
          .json,
      );
      keep((await post("/api/reviewer/explain", {}, 1)).json);
      keep(await (await fetch(`${base}/api/health`)).json());
      for (const [mode, code] of FAILURES) {
        fake.setMode(mode);
        const res = await post("/api/reviewer/explain", {});
        assert.equal(res.json.code, code, `${provider} ${JSON.stringify(mode)}`);
        keep(res.json);
      }
    }
    // Codex has no saved key; this one prints a key on stderr and fails.
    use("codex");
    const codex = await post("/api/reviewer/explain", {});
    assert.equal(codex.json.code, "CODEX_FAILED");
    keep(codex.json);
    keep(logs);
    assert.equal(logs.length, 2 * (3 + FAILURES.length) + 1);
    searched = dirs.flatMap(filesUnder);
    for (const file of searched) {
      const bytes = readFileSync(file);
      for (const key of [CLAUDE_KEY, LOCAL_KEY]) {
        assert.equal(bytes.includes(key), false, `${key.slice(0, 6)} found in ${file}`);
      }
    }
  });
  assert.ok(searched.some((f) => f.endsWith("supervisor.json")));
  const all = bodies.join("\n");
  assert.equal(all.includes(CLAUDE_KEY), false, "Claude key in a response or log line");
  assert.equal(all.includes(LOCAL_KEY), false, "local key in a response or log line");
  assert.match(all, /PROVIDER_KEY/, "the exact-key removal never ran");
});
