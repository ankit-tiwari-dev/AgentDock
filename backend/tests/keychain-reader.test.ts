import test from "node:test";
import assert from "node:assert/strict";
import { keychainCommand, type KeychainRunner } from "../src/keychain.ts";
import { keyStatusCache, readKey, requireKey } from "../src/key-reader.ts";
import { SupervisorError } from "../src/supervisor-provider.ts";

function runner(reply: { code: number | null; stdout?: string; enoent?: boolean }) {
  const calls: string[][] = [];
  const run: KeychainRunner = async (command, args) => {
    calls.push([command, ...args]);
    if (reply.enoent) {
      const spawnError = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
      return { code: null, stdout: "", stderr: "", spawnError };
    }
    return { code: reply.code, stdout: reply.stdout ?? "", stderr: "" };
  };
  return { run, calls };
}

test("a missing key gives KEY_MISSING naming the set-key command", async () => {
  const r = runner({ code: 44 });
  await assert.rejects(requireKey("claude", { platform: "darwin", runner: r.run }), (err: unknown) => {
    assert.ok(err instanceof SupervisorError);
    assert.deepEqual(err.body(), {
      error: "No Claude key saved. Run: ctrlplane supervisor set-key claude",
      code: "KEY_MISSING",
    });
    return true;
  });
  assert.equal(await readKey("openai-compatible", { platform: "linux", runner: runner({ code: 1 }).run }), null);
});

test("the read command per OS names only the service and account", () => {
  assert.deepEqual(keychainCommand("darwin", "get", "claude").args, [
    "find-generic-password",
    "-s",
    "agentdock",
    "-a",
    "claude",
    "-w",
  ]);
  assert.deepEqual(keychainCommand("linux", "get", "openai-compatible").args, [
    "lookup",
    "service",
    "agentdock",
    "account",
    "openai-compatible",
  ]);
  const win = keychainCommand("win32", "get", "claude");
  assert.deepEqual(win.args, ["-NoProfile", "-NonInteractive", "-Command", "iex ([Console]::In.ReadToEnd())"]);
  assert.match(win.stdin, /::Read\('agentdock:claude'/);
});

test("no keychain is read inside the container, and an unreadable keychain says why", async () => {
  const r = runner({ code: 0, stdout: "k" });
  await assert.rejects(readKey("claude", { runner: r.run, inContainer: true }), (err: unknown) => {
    assert.ok(err instanceof SupervisorError);
    assert.equal(err.code, "KEYCHAIN_UNAVAILABLE");
    assert.equal(err.message, "API providers need the host keychain, so they do not run in Docker.");
    return true;
  });
  assert.equal(r.calls.length, 0);
  await assert.rejects(readKey("claude", { platform: "linux", runner: runner({ code: null, enoent: true }).run }), {
    code: "KEYCHAIN_UNAVAILABLE",
    message: /^The OS keychain could not be read\. Install libsecret-tools/,
  });
});

test("the health key check is cached for 30 seconds, so streamed events do not start a keychain tool each time", async () => {
  let reads = 0;
  let now = 1_000;
  const has = keyStatusCache(
    async () => {
      reads++;
      return true;
    },
    { maxAgeMs: 30_000, now: () => now },
  );
  assert.equal(await has("claude"), true);
  now += 29_000;
  assert.equal(await has("claude"), true);
  assert.equal(reads, 1);
  now += 2_000;
  await has("claude");
  assert.equal(reads, 2);
});
