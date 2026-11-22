import { execFileSync } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeychainRunner } from "../src/keychain.ts";
import { AgentDockBackendServer } from "../src/server.ts";

/** Shared by the API-provider run tests: two git projects, a fake model server, a fake keychain and a fake codex. */

export const CLAUDE_KEY = `sk-ant-api03-${"Ru5v".repeat(12)}`;
/** No known pattern matches this, so only the exact-key removal can keep it out. */
export const LOCAL_KEY = `local-${"Wq3t".repeat(10)}`;
export const KEYS = { claude: CLAUDE_KEY, "openai-compatible": LOCAL_KEY };
export const PROVIDERS = ["claude", "openai-compatible"] as const;

export const QUESTIONS = {
  isRefined: false,
  clarificationQuestions: [{ id: "q1", question: "Which login?", whyItMatters: "Scope", suggestedAnswers: ["Google"] }],
};
export const PLAN = {
  isRefined: true,
  clarificationQuestions: [],
  lockedSpecification: {
    title: "Login",
    overview: "Add Google login",
    acceptanceCriteria: ["Users sign in"],
    specHash: "h1",
    instructionsForAgent2: "Build it",
    developerPrompt: "Implement Google login",
  },
};
export const REVIEW = { summary: "explained", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] };

export type Mode = "ok" | "hang" | "refusal" | "garbage" | { status: number };

interface Call {
  api: "anthropic" | "openai";
  context: string;
  model: unknown;
  path: string;
}

function answerFor(context: string, kind: "review" | "supervisor") {
  if (kind === "review") return REVIEW;
  return context.includes("USER ANSWERS") ? PLAN : QUESTIONS;
}

function sse(res: ServerResponse, text: string, stopReason: string) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  send("message_start", {
    type: "message_start",
    message: {
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-opus-5-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  if (stopReason !== "refusal") {
    send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
    send("content_block_stop", { type: "content_block_stop", index: 0 });
  }
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  send("message_stop", { type: "message_stop" });
  res.end();
}

/** One loopback server playing both the Anthropic API and an OpenAI-compatible server. */
export async function fakeModels() {
  const calls: Call[] = [];
  let mode: Mode = "ok";
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c: Buffer) => (raw += c.toString()));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      // Only the Anthropic SDK sends anthropic-version; both APIs list models at /v1/models.
      const api = req.headers["anthropic-version"] ? "anthropic" : "openai";
      const messages = (body.messages ?? []) as Array<{ role: string; content: string }>;
      const context = messages.at(-1)?.content ?? "";
      calls.push({ api, context, model: body.model, path: req.url ?? "" });
      // Echo the key this request carried, as a careless server or proxy might.
      const sentKey = String(req.headers.authorization ?? "").replace(/^Bearer /, "");
      if (mode === "hang") return;
      if (typeof mode === "object") {
        res.writeHead(mode.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "authentication_error", message: `bad key ${sentKey}` } }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/v1/models")) {
        const ids = api === "anthropic" ? ["claude-opus-5-5", "claude-sonnet-5-5"] : ["qwen3-coder", "llama3.2"];
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: ids.map((id) => ({ id, type: "model" })), has_more: false }));
        return;
      }
      if (api === "anthropic") {
        const schema = (body.output_config as { format: { schema: { properties: object } } }).format.schema;
        const answer = answerFor(context, "summary" in schema.properties ? "review" : "supervisor");
        sse(
          res,
          mode === "garbage" ? `not json ${sentKey}` : JSON.stringify(answer),
          mode === "refusal" ? "refusal" : "end_turn",
        );
        return;
      }
      const name = (body.response_format as { json_schema: { name: string } }).json_schema.name;
      const answer = answerFor(context, name === "review_result" ? "review" : "supervisor");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: "stop",
              message: {
                content:
                  mode === "refusal" ? null : mode === "garbage" ? `not json ${sentKey}` : JSON.stringify(answer),
                refusal: mode === "refusal" ? `refused ${sentKey}` : null,
              },
            },
          ],
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    setMode: (m: Mode) => (mode = m),
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

function gitProject(marker: string, big: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-api-run-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@agentdock.local");
  git("config", "user.name", "AgentDock test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, `${marker}.ts`), "export const v = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, `${marker}.ts`), `export const v = "${marker}-CHANGE";\n`);
  if (big) {
    writeFileSync(join(dir, "big.txt"), "line of text that changes\n".repeat(10_000));
    git("add", "big.txt");
  }
  return dir;
}

/** A codex that fails and prints a key on stderr, to prove stderr never reaches a response. */
const ECHO_CODEX = `process.stderr.write("codex saw " + process.env.FAKE_CODEX_ECHO); process.exit(2);`;

export interface Harness {
  base: string;
  dirs: string[];
  fake: Awaited<ReturnType<typeof fakeModels>>;
  logs: Array<Record<string, unknown>>;
  keychainCalls: () => number;
  use: (provider: "claude" | "openai-compatible" | "codex") => void;
  post: (path: string, body: unknown, project?: number) => Promise<{ status: number; json: Record<string, unknown> }>;
}

export async function withApiBackend(
  o: {
    keys?: Partial<Record<"claude" | "openai-compatible", string>>;
    env?: Record<string, string>;
    timeoutMs?: number;
    big?: boolean;
    /** A built dashboard to serve, for checks on the served pages. */
    staticRoot?: string;
    /** null leaves the server to find supervisor.json from `env`, as a real start does. */
    supervisorHome?: null;
  },
  fn: (h: Harness) => Promise<void>,
) {
  const home = mkdtempSync(join(tmpdir(), "agentdock-api-home-"));
  const a = gitProject("ALPHA", false);
  const b = gitProject("BRAVO", o.big ?? false);
  const codexScript = join(home, "echo-codex.mjs");
  writeFileSync(codexScript, ECHO_CODEX);
  process.env.FAKE_CODEX_ECHO = CLAUDE_KEY;
  const fake = await fakeModels();
  let keychainCalls = 0;
  const runner: KeychainRunner = async (_command, args) => {
    keychainCalls++;
    const key = o.keys?.[args.at(-1) as "claude" | "openai-compatible"];
    return key ? { code: 0, stdout: `${key}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "" };
  };
  const logs: Array<Record<string, unknown>> = [];
  const server = new AgentDockBackendServer({
    port: 0,
    projectPaths: [a, b],
    ...(o.supervisorHome === null ? {} : { supervisorHome: home }),
    env: o.env ?? {},
    keychain: { platform: "linux", runner },
    anthropicBaseUrl: fake.url,
    codexCommand: { file: process.execPath, prefixArgs: [codexScript] },
    runTimeoutMs: o.timeoutMs ?? 20_000,
    ...(o.staticRoot ? { staticRoot: o.staticRoot } : {}),
    logSink: (line) => logs.push(JSON.parse(line) as Record<string, unknown>),
  });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const { projects } = (await (await fetch(`${base}/api/projects`)).json()) as { projects: Array<{ id: string }> };
  const settings = {
    codex: { version: 1, provider: "codex" },
    claude: { version: 1, provider: "claude", model: "claude-opus-5-5" },
    "openai-compatible": {
      version: 1,
      provider: "openai-compatible",
      model: "qwen3-coder",
      openaiCompatible: { baseUrl: `${fake.url}/v1` },
    },
  };
  try {
    await fn({
      base,
      dirs: [home, a, b],
      fake,
      logs,
      keychainCalls: () => keychainCalls,
      use: (provider) => writeFileSync(join(home, "supervisor.json"), JSON.stringify(settings[provider])),
      post: async (path, body, project) => {
        const query = project === undefined ? "" : `?project=${projects[project].id}`;
        const res = await fetch(`${base}${path}${query}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as Record<string, unknown> };
      },
    });
  } finally {
    await server.stop();
    await fake.close();
    delete process.env.FAKE_CODEX_ECHO;
    for (const dir of [home, a, b]) rmSync(dir, { recursive: true, force: true });
  }
}
