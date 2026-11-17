import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  SupervisorError,
  classifyCodexExit,
  classifyHttpStatus,
  classifyNetworkError,
  scrub,
} from "../src/supervisor-provider.ts";

const planted = () => `planted-${randomBytes(24).toString("hex")}`;

test("each provider failure maps to its code and fixed message", () => {
  const key = planted();
  const body = `{"error":"bad key ${key}"}`;
  const http = (status: number) =>
    new SupervisorError(classifyHttpStatus(status), {
      detail: body,
      vars: { provider: "claude", model: "claude-opus-5-5", status },
    });
  const timeout = Object.assign(new Error(`aborted ${key}`), { name: "TimeoutError" });
  const refused = Object.assign(new Error(`connect ECONNREFUSED ${key}`), { code: "ECONNREFUSED" });
  const cases: Array<[SupervisorError, string, string]> = [
    [
      http(401),
      "KEY_REJECTED",
      "The Claude key was rejected. Save a new one with: ctrlplane supervisor set-key claude",
    ],
    [
      http(403),
      "KEY_REJECTED",
      "The Claude key was rejected. Save a new one with: ctrlplane supervisor set-key claude",
    ],
    [
      http(404),
      "MODEL_NOT_FOUND",
      "Model claude-opus-5-5 was not found. Pick another with: ctrlplane supervisor use claude <model>",
    ],
    [http(429), "RATE_LIMITED", "The provider is rate limiting requests. Try again later."],
    [http(500), "PROVIDER_ERROR", "The provider returned an error (HTTP 500). Try again later."],
    [
      new SupervisorError(classifyNetworkError(refused), { detail: refused.message }),
      "UNREACHABLE",
      "The provider is unreachable or timed out after 3 minutes. Check your network or local model server.",
    ],
    [
      new SupervisorError(classifyNetworkError(timeout), { detail: timeout.message }),
      "TIMEOUT",
      "The provider is unreachable or timed out after 3 minutes. Check your network or local model server.",
    ],
    [new SupervisorError("REFUSED", { detail: body }), "REFUSED", "The model declined this request."],
    [
      new SupervisorError("INVALID_ANSWER", { detail: body }),
      "INVALID_ANSWER",
      "The model did not return a valid answer. Try again, or pick a stronger model.",
    ],
    [
      new SupervisorError(classifyCodexExit(3), { detail: `stderr ${key}`, vars: { exitCode: 3, started: true } }),
      "CODEX_FAILED",
      "Codex CLI stopped with an error (exit code 3). See the backend log.",
    ],
  ];
  for (const [err, code, message] of cases) {
    assert.deepEqual(err.body(), { error: message, code });
    assert.equal(JSON.stringify(err.body()).includes(key), false, code);
    assert.equal(err.message.includes(key), false, code);
  }
});

test("regression: the logged error detail is redacted, has the exact saved key removed and is cut to 2000 characters", () => {
  const key = planted();
  const anthropic = `sk-ant-api03-${randomBytes(24).toString("hex")}`;
  const body = `${"x".repeat(100)} ${key} ${anthropic} `.repeat(60);
  assert.ok(body.length > 10_000);
  const out = scrub(body, key);
  assert.ok(out.length <= 2000, String(out.length));
  assert.equal(out.includes(key), false);
  assert.equal(out.includes(anthropic.slice(13)), false);
  assert.match(out, /\[REDACTED_SECRET:PROVIDER_KEY\]/);
  assert.equal(scrub("plain text", null), "plain text");
});
