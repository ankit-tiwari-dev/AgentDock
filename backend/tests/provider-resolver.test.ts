import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isInContainer, resolveSupervisor } from "../src/provider-resolver.ts";

function withHome(fn: (home: string, write: (value: unknown) => void) => void) {
  const home = mkdtempSync(join(tmpdir(), "agentdock-resolver-"));
  try {
    fn(home, (value) =>
      writeFileSync(join(home, "supervisor.json"), typeof value === "string" ? value : JSON.stringify(value)),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test("the config file wins over AGENTDOCK_CODEX, and the env var alone means codex with its default model", () => {
  withHome((home, write) => {
    assert.deepEqual(resolveSupervisor({ home, env: {} }), { state: "off" });
    assert.deepEqual(resolveSupervisor({ home, env: { AGENTDOCK_CODEX: "1" } }), {
      state: "on",
      provider: "codex",
      model: null,
      baseUrl: null,
      source: "env",
    });
    write({ version: 1, provider: "codex", model: "gpt-5.5-codex" });
    assert.deepEqual(resolveSupervisor({ home, env: { AGENTDOCK_CODEX: "0" } }), {
      state: "on",
      provider: "codex",
      model: "gpt-5.5-codex",
      baseUrl: null,
      source: "config",
    });
    // An explicit override (tests, embedding) wins over both.
    assert.deepEqual(resolveSupervisor({ home, env: {}, codexEnabledOverride: false }), { state: "off" });
  });
});

test("supervisor.json is read again on every run", () => {
  withHome((home, write) => {
    write({ version: 1, provider: "codex" });
    assert.equal(resolveSupervisor({ home, env: {} }).state, "on");
    write({ version: 1, provider: "codex", model: "m2" });
    const again = resolveSupervisor({ home, env: {} });
    assert.equal(again.state === "on" && again.model, "m2");
  });
});

test("regression: a hand-edited base URL that breaks the rule is refused before any run", () => {
  withHome((home, write) => {
    const fixture = JSON.parse(readFileSync(new URL("./fixtures/supervisor.v1.json", import.meta.url), "utf8"));
    write({ ...fixture, openaiCompatible: { baseUrl: "http://192.168.1.5:11434/v1" } });
    assert.deepEqual(resolveSupervisor({ home, env: { AGENTDOCK_CODEX: "1" } }), {
      state: "invalid",
      problem: "base-url",
    });
    write({ ...fixture, openaiCompatible: { baseUrl: "https://u:p@h.example/v1" } });
    assert.deepEqual(resolveSupervisor({ home, env: {} }), { state: "invalid", problem: "base-url" });
  });
});

test("an unknown file version makes the settings invalid, never a silent fall back to the env var or built-in", () => {
  withHome((home, write) => {
    write({ version: 2, provider: "codex" });
    assert.deepEqual(resolveSupervisor({ home, env: { AGENTDOCK_CODEX: "1" } }), {
      state: "invalid",
      problem: "version",
    });
    write("{not json");
    assert.deepEqual(resolveSupervisor({ home, env: {} }), { state: "invalid", problem: "json" });
  });
});

test("a provider this backend cannot run yet is reported, not run", () => {
  withHome((home, write) => {
    write({ version: 1, provider: "claude", model: "claude-opus-5-5" });
    assert.deepEqual(resolveSupervisor({ home, env: {} }), { state: "invalid", problem: "unsupported" });
  });
  assert.equal(isInContainer({ AGENTDOCK_IN_CONTAINER: "1" }), true);
  assert.equal(isInContainer({}), false);
});
