import { redactSecrets } from "./redactor.ts";
import type { ProviderName } from "./supervisor-config.ts";
import type { ReviewResult, SupervisorResult } from "./supervisor-schemas.ts";

export type { ProviderName };
export type RunMode = "questions" | "finalize" | "review";

/** Only a non-blank answer is a decision, so an empty or blank answer map can never lock a plan nobody chose. */
export function interviewMode(developerAnswers?: Record<string, string>): "questions" | "finalize" {
  return Object.values(developerAnswers ?? {}).some((answer) => answer.trim() !== "") ? "finalize" : "questions";
}

export function isAnswerMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((answer) => typeof answer === "string")
  );
}

export interface RunContext {
  projectPath: string;
  model: string | null;
  signal: AbortSignal;
  context?: string;
}

/** One way to plan and explain. Codex, Claude and an OpenAI-compatible server each implement it. */
export interface SupervisorProvider {
  interview(
    featurePrompt: string,
    developerAnswers?: Record<string, string>,
    ctx?: RunContext,
  ): Promise<SupervisorResult>;
  review(ctx?: RunContext): Promise<ReviewResult>;
}

export type SupervisorCode =
  | "NO_PROVIDER"
  | "CODEX_OFF"
  | "CONFIG_INVALID"
  | "KEY_MISSING"
  | "KEYCHAIN_UNAVAILABLE"
  | "KEY_REJECTED"
  | "MODEL_NOT_FOUND"
  | "RATE_LIMITED"
  | "UNREACHABLE"
  | "TIMEOUT"
  | "REFUSED"
  | "INVALID_ANSWER"
  | "CONTEXT_TOO_LARGE"
  | "GIT_FAILED"
  | "PROVIDER_ERROR"
  | "CODEX_FAILED"
  | "BUSY";

/** Only fixed values go in here (labels, the model from the validated file, numbers), never provider or stderr text. */
export interface MessageVars {
  provider?: ProviderName;
  model?: string | null;
  problem?: string;
  status?: number;
  exitCode?: number | null;
  kb?: number;
  /** The size is a lower bound: git printed more than the backend reads. */
  atLeast?: boolean;
  mode?: RunMode;
  inContainer?: boolean;
  hint?: string;
  started?: boolean;
}

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  codex: "Codex",
  claude: "Claude",
  "openai-compatible": "OpenAI-compatible",
};

const OFF =
  "Explaining changes needs a supervisor. Run: ctrlplane supervisor use <codex|claude|openai-compatible> <model>, or restart the backend with AGENTDOCK_CODEX=1 to use Codex.";
const UNREACHABLE =
  "The provider is unreachable or timed out after 3 minutes. Check your network or local model server.";

export const ERROR_MESSAGES: Record<SupervisorCode, (v: MessageVars) => string> = {
  NO_PROVIDER: () => OFF,
  CODEX_OFF: () => OFF,
  CONFIG_INVALID: (v) =>
    v.problem === "home"
      ? "The supervisor settings file cannot be used: CTRLPLANE_HOME is relative or inside a project. Set it to a full path outside your projects."
      : `The supervisor settings file cannot be used (${v.problem ?? "invalid"}). Rewrite it with: ctrlplane supervisor use <provider> <model>`,
  KEY_MISSING: (v) =>
    `No ${PROVIDER_LABEL[v.provider ?? "claude"]} key saved. Run: ctrlplane supervisor set-key ${v.provider ?? "claude"}`,
  KEYCHAIN_UNAVAILABLE: (v) =>
    v.inContainer
      ? "API providers need the host keychain, so they do not run in Docker."
      : `The OS keychain could not be read. ${v.hint ?? ""}`.trim(),
  KEY_REJECTED: (v) =>
    `The ${PROVIDER_LABEL[v.provider ?? "claude"]} key was rejected. Save a new one with: ctrlplane supervisor set-key ${v.provider ?? "claude"}`,
  MODEL_NOT_FOUND: (v) =>
    `Model ${v.model ?? ""} was not found. Pick another with: ctrlplane supervisor use ${v.provider ?? "<provider>"} <model>`,
  RATE_LIMITED: () => "The provider is rate limiting requests. Try again later.",
  UNREACHABLE: () => UNREACHABLE,
  TIMEOUT: () => UNREACHABLE,
  REFUSED: () => "The model declined this request.",
  INVALID_ANSWER: () => "The model did not return a valid answer. Try again, or pick a stronger model.",
  CONTEXT_TOO_LARGE: (v) => {
    const size = `${v.atLeast ? "more than " : ""}${(v.kb ?? 0).toLocaleString("en-US")} KB`;
    return v.mode === "review"
      ? `The changes are ${size}; the limit is 200 KB. Commit or stash part of them and try again.`
      : `The request and file list are ${size}; the limit is 200 KB. Shorten the description and try again.`;
  },
  GIT_FAILED: () => "Could not read the project's git state. Is the project folder a git repository?",
  PROVIDER_ERROR: (v) => `The provider returned an error (HTTP ${v.status ?? 0}). Try again later.`,
  CODEX_FAILED: (v) =>
    v.started
      ? `Codex CLI stopped with an error (exit code ${v.exitCode ?? "none"}). See the backend log.`
      : "Codex CLI could not be started. Install it or set AGENTDOCK_CODEX_PATH.",
  BUSY: () => "A supervisor run is already in progress. Wait for it to finish.",
};

/** `message` is the fixed text the browser may see; `detail` is for the run log only, after `scrub`. */
export class SupervisorError extends Error {
  readonly code: SupervisorCode;
  readonly detail?: string;
  readonly vars: MessageVars;
  constructor(code: SupervisorCode, o: { detail?: string; vars?: MessageVars } = {}) {
    super(ERROR_MESSAGES[code](o.vars ?? {}));
    this.name = "SupervisorError";
    this.code = code;
    this.detail = o.detail;
    this.vars = o.vars ?? {};
  }

  body(): { error: string; code: SupervisorCode } {
    return { error: this.message, code: this.code };
  }
}

export function classifyHttpStatus(status: number): SupervisorCode {
  if (status === 401 || status === 403) return "KEY_REJECTED";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return "PROVIDER_ERROR";
}

export function classifyNetworkError(err: unknown): "TIMEOUT" | "UNREACHABLE" {
  const name = (err as Error | undefined)?.name;
  return name === "TimeoutError" || name === "AbortError" ? "TIMEOUT" : "UNREACHABLE";
}

export function classifyCodexExit(_code: number | null): SupervisorCode {
  return "CODEX_FAILED";
}

/**
 * Pattern redaction cannot know a key of unknown format, so the exact saved key is removed too, first, before a
 * pattern could rewrite part of it and hide the rest from the exact match.
 */
export function scrub(text: string, key: string | null, max = 2000): string {
  const withoutKey = key ? text.split(key).join("[REDACTED_SECRET:PROVIDER_KEY]") : text;
  return redactSecrets(withoutKey).sanitized.slice(0, max);
}
