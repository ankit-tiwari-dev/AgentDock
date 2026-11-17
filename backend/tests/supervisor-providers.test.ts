import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDockBackendServer } from "../src/server.ts";

/** Records its arguments; FAKE_MODE picks ok, fail or hold (waits for a release file before answering). */
const FAKE = `
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const dir = process.env.FAKE_DIR;
writeFileSync(dir + "/args.json", JSON.stringify(args));
const out = args[args.indexOf("--output-last-message") + 1];
const mode = readFileSync(dir + "/mode", "utf8");
if (mode === "fail") { process.stderr.write("internal failure " + readFileSync(dir + "/secret", "utf8")); process.exit(2); }
const answer = () => writeFileSync(out, JSON.stringify({ summary: "fake review", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] }));
readFileSync(0);
if (mode === "hold") { const t = setInterval(() => { if (existsSync(dir + "/release")) { clearInterval(t); answer(); } }, 20); }
else answer();
`;

interface Harness {
  base: string;
  dir: string;
  logs: Array<Record<string, unknown>>;
  writeConfig: (value: unknown) => void;
  mode: (m: "ok" | "fail" | "hold") => void;
  codexArgs: () => string[];
}

async function withBackend(env: Record<string, string>, fn: (h: Harness) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-sup-"));
  const script = join(dir, "fake.mjs");
  writeFileSync(script, FAKE);
  writeFileSync(join(dir, "mode"), "ok");
  writeFileSync(join(dir, "secret"), `sk-ant-api03-${"Z".repeat(40)}`);
  process.env.FAKE_DIR = dir;
  const logs: Array<Record<string, unknown>> = [];
  const server = new AgentDockBackendServer({
    port: 0,
    supervisorHome: dir,
    env,
    codexCommand: { file: process.execPath, prefixArgs: [script] },
    logSink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { port } = await server.start();
  try {
    await fn({
      base: `http://127.0.0.1:${port}`,
      dir,
      logs,
      writeConfig: (value) => writeFileSync(join(dir, "supervisor.json"), JSON.stringify(value)),
      mode: (m) => writeFileSync(join(dir, "mode"), m),
      codexArgs: () => JSON.parse(readFileSync(join(dir, "args.json"), "utf8")) as string[],
    });
  } finally {
    await server.stop();
    delete process.env.FAKE_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
}

const explain = async (base: string) => {
  const res = await fetch(`${base}/api/reviewer/explain`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

test("with no supervisor set, explain names both ways to turn one on, with a code", async () => {
  await withBackend({}, async ({ base }) => {
    assert.deepEqual(await explain(base), {
      status: 503,
      json: {
        error:
          "Explaining changes needs a supervisor. Run: ctrlplane supervisor use <codex|claude|openai-compatible> <model>, or restart the backend with AGENTDOCK_CODEX=1 to use Codex.",
        code: "CODEX_OFF",
      },
    });
  });
});

test("with nothing set the plan uses the built-in interview; AGENTDOCK_CODEX=1 alone runs Codex with its default model", async () => {
  await withBackend({}, async ({ base, logs }) => {
    const res = await fetch(`${base}/api/supervisor/interview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featurePrompt: "Add Google login" }),
    });
    assert.equal(res.status, 200);
    assert.ok(((await res.json()) as { clarificationQuestions: unknown[] }).clarificationQuestions.length > 0);
    assert.equal(logs.length, 0);
  });
  await withBackend({ AGENTDOCK_CODEX: "1" }, async ({ base, codexArgs }) => {
    const health = (await (await fetch(`${base}/api/health`)).json()) as { codexEnabled: boolean; supervisor: unknown };
    assert.equal(health.codexEnabled, true);
    assert.deepEqual(health.supervisor, { provider: "codex", model: null, keySaved: null, ready: true });
    assert.equal((await explain(base)).status, 200);
    assert.equal(codexArgs().includes("-m"), false);
  });
});

test("ctrlplane supervisor use codex <model> applies without a restart and the model reaches codex", async () => {
  await withBackend({}, async ({ base, writeConfig, codexArgs, logs }) => {
    assert.equal((await explain(base)).status, 503);
    writeConfig({ version: 1, provider: "codex", model: "gpt-5.5-codex" });
    const res = await explain(base);
    assert.equal(res.status, 200);
    assert.equal(res.json.summary, "fake review");
    const args = codexArgs();
    assert.deepEqual(args.slice(args.indexOf("-m"), args.indexOf("-m") + 2), ["-m", "gpt-5.5-codex"]);
    assert.equal(logs.length, 1);
    assert.deepEqual(
      { ...logs[0], duration_ms: 0, project_id: "" },
      {
        event: "supervisor_run",
        provider: "codex",
        model: "gpt-5.5-codex",
        project_id: "",
        mode: "review",
        duration_ms: 0,
        outcome: "ok",
        context_bytes: null,
      },
    );
  });
});

test("regression: a failed run sends fixed text and a code, never the provider's own output", async () => {
  await withBackend({ AGENTDOCK_CODEX: "1" }, async ({ base, mode, logs }) => {
    mode("fail");
    const res = await explain(base);
    assert.deepEqual(res, {
      status: 503,
      json: { error: "Codex CLI stopped with an error (exit code 2). See the backend log.", code: "CODEX_FAILED" },
    });
    assert.equal(logs[0].outcome, "CODEX_FAILED");
    assert.match(String(logs[0].error_detail), /^internal failure /);
    assert.equal(JSON.stringify(logs).includes("Z".repeat(40)), false);
  });
});

test("a settings file that cannot be used stops the run with CONFIG_INVALID instead of falling back", async () => {
  await withBackend({ AGENTDOCK_CODEX: "1" }, async ({ base, writeConfig, logs }) => {
    writeConfig({
      version: 1,
      provider: "openai-compatible",
      model: "m",
      openaiCompatible: { baseUrl: "http://10.0.0.2/v1" },
    });
    const res = await explain(base);
    assert.equal(res.status, 503);
    assert.equal(res.json.code, "CONFIG_INVALID");
    const interview = await fetch(`${base}/api/supervisor/interview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ featurePrompt: "Add a flag" }),
    });
    assert.equal(interview.status, 503);
    assert.equal(((await interview.json()) as { code: string }).code, "CONFIG_INVALID");
    assert.deepEqual(
      logs.map((l) => [l.outcome, l.mode]),
      [
        ["CONFIG_INVALID", "review"],
        ["CONFIG_INVALID", "questions"],
      ],
    );
  });
});

test("only one supervisor run at a time; the second gets 409 with code BUSY", async () => {
  await withBackend({ AGENTDOCK_CODEX: "1" }, async ({ base, dir, mode }) => {
    mode("hold");
    const first = explain(base);
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        readFileSync(join(dir, "args.json"));
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    try {
      // Without the lock the second run would wait on the held one, so it gives up instead of hanging the suite.
      const second = await fetch(`${base}/api/reviewer/explain`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(5_000),
      });
      assert.deepEqual(
        { status: second.status, json: await second.json() },
        {
          status: 409,
          json: { error: "A supervisor run is already in progress. Wait for it to finish.", code: "BUSY" },
        },
      );
    } finally {
      writeFileSync(join(dir, "release"), "");
    }
    assert.equal((await first).status, 200);
  });
});

test("health reports the supervisor in use and follows the settings file", async () => {
  await withBackend({}, async ({ base, writeConfig }) => {
    const health = async () =>
      (await (await fetch(`${base}/api/health`)).json()) as { codexEnabled: boolean; supervisor: unknown };
    assert.deepEqual(await health(), {
      ...(await health()),
      codexEnabled: false,
      supervisor: { provider: null, model: null, keySaved: null, ready: false },
    });
    writeConfig({ version: 1, provider: "codex", model: "gpt-5.5-codex" });
    const on = await health();
    assert.equal(on.codexEnabled, true);
    assert.deepEqual(on.supervisor, { provider: "codex", model: "gpt-5.5-codex", keySaved: null, ready: true });
  });
});
