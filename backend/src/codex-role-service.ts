import { spawn } from "node:child_process";
import { delimiter, resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { reviewSchema, supervisorSchema, type ReviewResult, type SupervisorResult } from "./supervisor-schemas.ts";
import {
  SupervisorError,
  interviewMode,
  classifyCodexExit,
  scrub,
  type RunContext,
  type SupervisorProvider,
} from "./supervisor-provider.ts";

export type { ReviewResult, SupervisorResult };

export interface CodexOptions {
  /** A fake codex in tests is `{ file: process.execPath, prefixArgs: [script] }`: Windows cannot spawn a .cmd without a shell. */
  command?: { file: string; prefixArgs: string[] };
  timeoutMs?: number;
}

/** `-m` only when a model is set, so `AGENTDOCK_CODEX=1` alone keeps Codex's own default. */
export function codexArgs(projectPath: string, schemaPath: string, outputPath: string, model: string | null): string[] {
  return [
    "exec",
    "--ephemeral",
    "--sandbox",
    "read-only",
    ...(model ? ["-m", model] : []),
    "--cd",
    projectPath,
    "--output-schema",
    schemaPath,
    "--output-last-message",
    outputPath,
    "-",
  ];
}

export class CodexRoleService implements SupervisorProvider {
  private readonly projectPath: string;
  private readonly options: CodexOptions;
  constructor(projectPath = process.cwd(), options: CodexOptions = {}) {
    this.projectPath = projectPath;
    this.options = options;
  }

  async interview(
    featurePrompt: string,
    developerAnswers?: Record<string, string>,
    ctx?: RunContext,
  ): Promise<SupervisorResult> {
    const mode = interviewMode(developerAnswers);
    const prompt =
      mode === "questions"
        ? `You are the product supervisor for this software repository. Inspect relevant files read-only, then clarify the feature request below. Ask 2-4 concrete, high-impact questions only where repository context and the request do not already answer them. Suggested answers should be short, realistic choices. Do not implement or edit files. Return isRefined=false and clarificationQuestions; omit lockedSpecification.\n\nFEATURE REQUEST:\n${featurePrompt}`
        : `You are the product supervisor for this software repository. Use the feature request, the user's answers, and repository context to produce a precise implementation specification. Do not edit files. Return isRefined=true, an empty clarificationQuestions array, and lockedSpecification including a concise title, overview, testable acceptance criteria, a short identifier in specHash, and a complete developerPrompt. The developerPrompt must include the original request, each user's answer, repository-specific constraints, and acceptance criteria. Tell the developer to inspect the project, implement the feature, run relevant tests, and report changed files and evidence.\n\nFEATURE REQUEST:\n${featurePrompt}\n\nUSER ANSWERS (JSON):\n${JSON.stringify(developerAnswers)}`;
    return this.runStructured<SupervisorResult>(prompt, supervisorSchema, ctx);
  }

  async review(ctx?: RunContext): Promise<ReviewResult> {
    const prompt =
      "Review the current repository changes for the user. Inspect git status, git diff HEAD, and relevant changed files read-only. Explain in plain, simple English what changed and how it works. Report tests only when there is evidence in the repository or command output; do not claim tests were run if you did not run them. Mention concrete risks and useful next steps. Do not edit files. If the working tree has no changes, say so clearly in the summary and changes list.";
    return this.runStructured<ReviewResult>(prompt, reviewSchema, ctx);
  }

  private async runStructured<T>(prompt: string, schema: object, ctx?: RunContext): Promise<T> {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdock-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const command = this.options.command ?? { file: findCodexExecutable(), prefixArgs: [] };
    const timeoutMs = this.options.timeoutMs ?? 180_000;
    try {
      await new Promise<void>((resolve, reject) => {
        const home = process.env.HOME || process.env.USERPROFILE;
        const codexHome = process.env.CODEX_HOME || (home ? join(home, ".codex") : undefined);
        // The child gets this process's environment only; the backend never puts a saved API key into it.
        const child = spawn(
          command.file,
          [...command.prefixArgs, ...codexArgs(this.projectPath, schemaPath, outputPath, ctx?.model ?? null)],
          {
            windowsHide: true,
            stdio: ["pipe", "ignore", "pipe"],
            env: { ...process.env, ...(home ? { HOME: home } : {}), ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
          },
        );
        let stderr = "";
        let settled = false;
        const finish = (err?: SupervisorError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          ctx?.signal.removeEventListener("abort", onAbort);
          if (err) reject(err);
          else resolve();
        };
        const stop = (err: SupervisorError) => {
          child.kill();
          finish(err);
        };
        const onAbort = () => stop(new SupervisorError("TIMEOUT", { detail: "aborted" }));
        const timer = setTimeout(
          () => stop(new SupervisorError("TIMEOUT", { detail: `no answer after ${timeoutMs} ms` })),
          timeoutMs,
        );
        ctx?.signal.addEventListener("abort", onAbort);
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-6000);
        });
        child.on("error", (error) =>
          finish(new SupervisorError("CODEX_FAILED", { detail: scrub(error.message, null), vars: { started: false } })),
        );
        child.on("close", (code) => {
          if (code === 0) finish();
          else
            finish(
              new SupervisorError(classifyCodexExit(code), {
                detail: scrub(stderr, null),
                vars: { started: true, exitCode: code },
              }),
            );
        });
        child.stdin.on("error", () => {});
        child.stdin.end(prompt);
      });
      try {
        return JSON.parse(await readFile(outputPath, "utf8")) as T;
      } catch (err) {
        throw new SupervisorError("INVALID_ANSWER", { detail: scrub(String(err), null) });
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}

function findCodexExecutable(): string {
  const configured = process.env.AGENTDOCK_CODEX_PATH;
  if (configured) return configured;
  const binary = process.platform === "win32" ? "codex.exe" : "codex";
  for (const directory of (process.env.PATH || "").split(delimiter).filter(Boolean)) {
    const candidate = resolve(directory, binary);
    if (existsSync(candidate)) return candidate;
  }
  if (process.platform === "win32") {
    const profile = process.env.USERPROFILE || process.env.HOME;
    if (profile) {
      for (const extensionRoot of [
        join(profile, ".antigravity-ide", "extensions"),
        join(profile, ".vscode", "extensions"),
      ]) {
        try {
          const folders = readdirSync(extensionRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory() && entry.name.startsWith("openai.chatgpt-"))
            .sort((a, b) => b.name.localeCompare(a.name));
          for (const folder of folders) {
            const candidate = join(extensionRoot, folder.name, "bin", "windows-x86_64", binary);
            if (existsSync(candidate)) return candidate;
          }
        } catch {
          /* Extension installation directories are optional. */
        }
      }
    }
  }
  return binary;
}
