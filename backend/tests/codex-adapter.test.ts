import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexRoleService, codexArgs } from "../src/codex-role-service.ts";
import { SupervisorError } from "../src/supervisor-provider.ts";

/**
 * A stand-in for codex: records its arguments, then behaves per FAKE_CODEX_MODE (ok, fail, hang, garbage). Run as
 * `node fake.mjs ...` because Windows cannot spawn a script file directly without a shell.
 */
const FAKE = `
import { readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
writeFileSync(process.env.FAKE_CODEX_ARGS, JSON.stringify(args));
writeFileSync(process.env.FAKE_CODEX_ARGS + ".env", JSON.stringify(Object.keys(process.env)));
const out = args[args.indexOf("--output-last-message") + 1];
const mode = process.env.FAKE_CODEX_MODE;
if (mode === "fail") { process.stderr.write("boom " + process.env.FAKE_CODEX_SECRET); process.exit(3); }
if (mode === "hang") setInterval(() => {}, 1000);
else {
  readFileSync(0);
  writeFileSync(out, mode === "garbage" ? "not json" : JSON.stringify({ summary: "ok", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] }));
}
`;

function withFake(mode: string, fn: (svc: CodexRoleService, argsFile: string) => Promise<void>, timeoutMs = 20_000) {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-fake-codex-"));
  const script = join(dir, "fake.mjs");
  const argsFile = join(dir, "args.json");
  writeFileSync(script, FAKE);
  const saved = { ...process.env };
  Object.assign(process.env, {
    FAKE_CODEX_MODE: mode,
    FAKE_CODEX_ARGS: argsFile,
    FAKE_CODEX_SECRET: "sk-ant-api03-" + "Q".repeat(40),
  });
  const svc = new CodexRoleService(dir, { command: { file: process.execPath, prefixArgs: [script] }, timeoutMs });
  return fn(svc, argsFile).finally(() => {
    for (const k of ["FAKE_CODEX_MODE", "FAKE_CODEX_ARGS", "FAKE_CODEX_SECRET"]) delete process.env[k];
    Object.assign(process.env, saved);
    rmSync(dir, { recursive: true, force: true });
  });
}

const ctx = (model: string | null) => ({ projectPath: "", model, signal: new AbortController().signal });

test("codex gets -m only when a model is set, so the env-var path keeps Codex's own default", () => {
  assert.equal(codexArgs("/p", "s", "o", null).includes("-m"), false);
  const withModel = codexArgs("/p", "s", "o", "gpt-5.5-codex");
  assert.deepEqual(withModel.slice(withModel.indexOf("-m"), withModel.indexOf("-m") + 2), ["-m", "gpt-5.5-codex"]);
  assert.equal(withModel.at(-1), "-");
});

test("a saved model reaches the codex command line and the answer comes back", async () => {
  await withFake("ok", async (svc, argsFile) => {
    const result = await svc.review(ctx("gpt-5.5-codex"));
    assert.equal(result.summary, "ok");
    const args = JSON.parse(readFileSync(argsFile, "utf8")) as string[];
    assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.5-codex"]);
  });
});

test("regression: the codex child process gets only this process's environment plus HOME and CODEX_HOME", async () => {
  await withFake("ok", async (svc, argsFile) => {
    await svc.review(ctx(null));
    const childKeys = new Set(JSON.parse(readFileSync(`${argsFile}.env`, "utf8")) as string[]);
    const added = [...childKeys].filter((k) => !(k in process.env) && k.toUpperCase() !== "HOME");
    assert.deepEqual(
      added.filter((k) => k !== "CODEX_HOME"),
      [],
    );
  });
});

test("regression: a codex failure gives fixed text to the browser and keeps stderr, redacted, for the log only", async () => {
  await withFake("fail", async (svc) => {
    await assert.rejects(svc.review(ctx(null)), (err: unknown) => {
      assert.ok(err instanceof SupervisorError);
      assert.deepEqual(err.body(), {
        error: "Codex CLI stopped with an error (exit code 3). See the backend log.",
        code: "CODEX_FAILED",
      });
      assert.match(err.detail ?? "", /^boom /);
      assert.equal((err.detail ?? "").includes("Q".repeat(40)), false);
      return true;
    });
  });
});

test("a codex run that never answers is stopped as TIMEOUT", async () => {
  await withFake(
    "hang",
    async (svc) => {
      await assert.rejects(svc.review(ctx(null)), { code: "TIMEOUT" });
    },
    500,
  );
});

test("an answer that is not JSON is INVALID_ANSWER, not a crash", async () => {
  await withFake("garbage", async (svc) => {
    await assert.rejects(svc.review(ctx(null)), { code: "INVALID_ANSWER" });
  });
});
