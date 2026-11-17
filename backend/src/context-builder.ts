import { execFile } from "node:child_process";
import { redactSecrets } from "./redactor.ts";
import { SupervisorError, type RunMode } from "./supervisor-provider.ts";

export const CONTEXT_CAP_BYTES = 204_800;
export const MAX_LISTED_FILES = 2_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export interface BuiltContext {
  text: string;
  bytes: number;
}

const QUESTIONS_ROLE =
  "You are the product supervisor for this software repository. Using the repository file list below, clarify the feature request. Ask 2-4 concrete, high-impact questions only where the file list and the request do not already answer them. Suggested answers should be short, realistic choices. Return isRefined=false and clarificationQuestions; omit lockedSpecification.";
const FINALIZE_ROLE =
  "You are the product supervisor for this software repository. Use the feature request, the user's answers and the repository file list to produce a precise implementation specification. Return isRefined=true, an empty clarificationQuestions array, and lockedSpecification including a concise title, overview, testable acceptance criteria, a short identifier in specHash, and a complete developerPrompt. The developerPrompt must include the original request, each of the user's answers, repository-specific constraints and acceptance criteria. Tell the developer to inspect the project, implement the feature, run relevant tests, and report changed files and evidence.";
const REVIEW_ROLE =
  "Review the repository changes below for the user. Explain in plain, simple English what changed and how it works. Report tests only when the changes below show evidence of them; never claim tests were run. Mention concrete risks and useful next steps. If there are no changes, say so clearly in the summary and changes list.";

/**
 * No shell, so file names are only data. The `-c` flags and `--no-ext-diff`/`--no-textconv` stop a repo's own config
 * from starting a program, and GIT_OPTIONAL_LOCKS=0 keeps the index unlocked for the developer's agent.
 */
function git(projectPath: string, args: string[], mode: RunMode): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", ...args],
      {
        cwd: projectPath,
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: GIT_MAX_BUFFER,
        encoding: "utf8",
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (!error) return resolve(stdout);
        if ((error as { code?: unknown }).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          return reject(
            new SupervisorError("CONTEXT_TOO_LARGE", { vars: { mode, kb: GIT_MAX_BUFFER / 1024, atLeast: true } }),
          );
        }
        reject(new SupervisorError("GIT_FAILED", { detail: `git ${args[0]} failed` }));
      },
    );
  });
}

/** Redact first, then measure, so the cap applies to exactly what would be sent. Never cut silently. */
function finish(sections: string[], mode: RunMode): BuiltContext {
  const text = redactSecrets(sections.join("\n\n")).sanitized;
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > CONTEXT_CAP_BYTES) {
    throw new SupervisorError("CONTEXT_TOO_LARGE", { vars: { mode, kb: Math.ceil(bytes / 1024) } });
  }
  return { text, bytes };
}

export async function buildInterviewContext(
  projectPath: string,
  featurePrompt: string,
  answers?: Record<string, string>,
): Promise<BuiltContext> {
  const mode: RunMode = answers ? "finalize" : "questions";
  const files = (await git(projectPath, ["ls-files", "-z"], mode)).split("\0").filter(Boolean);
  const listed = files.slice(0, MAX_LISTED_FILES);
  return finish(
    [
      answers ? FINALIZE_ROLE : QUESTIONS_ROLE,
      `FEATURE REQUEST:\n${featurePrompt}`,
      ...(answers ? [`USER ANSWERS (JSON):\n${JSON.stringify(answers)}`] : []),
      `REPOSITORY FILES (${listed.length} of ${files.length}):\n${listed.join("\n")}`,
    ],
    mode,
  );
}

export async function buildReviewContext(projectPath: string): Promise<BuiltContext> {
  const status = await git(projectPath, ["status", "--porcelain=v1"], "review");
  const hasCommit = await git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD"], "review").then(
    () => true,
    () => false,
  );
  const diffFlags = ["--no-color", "--no-ext-diff", "--no-textconv"];
  const diff = await git(
    projectPath,
    hasCommit ? ["diff", ...diffFlags, "HEAD"] : ["diff", ...diffFlags, "--cached"],
    "review",
  );
  const untracked = await git(projectPath, ["ls-files", "--others", "--exclude-standard"], "review");
  return finish(
    [
      REVIEW_ROLE,
      `GIT STATUS:\n${status.trimEnd()}`,
      `GIT DIFF HEAD:\n${diff.trimEnd()}`,
      `UNTRACKED FILES:\n${untracked.trimEnd()}`,
    ],
    "review",
  );
}
