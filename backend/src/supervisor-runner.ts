import { ClaudeProvider } from "./claude-provider.ts";
import { buildInterviewContext, buildReviewContext } from "./context-builder.ts";
import { readKey, requireKey, type KeyReadOptions } from "./key-reader.ts";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.ts";
import type { Project } from "./projects.ts";
import { isInContainer, type ResolvedSupervisor } from "./provider-resolver.ts";
import { formatRunLog, type RunLogLine } from "./run-log.ts";
import { checkBaseUrl } from "./supervisor-config.ts";
import { SupervisorError, scrub, type RunMode, type SupervisorProvider } from "./supervisor-provider.ts";
import type { ReviewResult, SupervisorResult } from "./supervisor-schemas.ts";
import type { SupervisorInterviewRequest } from "./types.ts";

export interface RunnerDeps {
  timeoutMs: number;
  logSink: (line: string) => void;
  env: Record<string, string | undefined>;
  /** Replaces the OS keychain tool, for tests. */
  keychain?: Omit<KeyReadOptions, "inContainer">;
  /** Replaces the Anthropic API address, for tests. */
  anthropicBaseUrl?: string;
}

type On = Extract<ResolvedSupervisor, { state: "on" }>;

function asSupervisorError(err: unknown, key: string | null): SupervisorError {
  if (err instanceof SupervisorError) return err;
  // A provider that throws something else still reaches the browser only as fixed text.
  return new SupervisorError("PROVIDER_ERROR", {
    detail: scrub(err instanceof Error ? err.message : String(err), key),
    vars: { status: 0 },
  });
}

/**
 * The API providers get the key, then the context, before any network call, so a missing key or an oversized change
 * stops the run with nothing sent. Codex reads the repository itself.
 */
async function prepareApiRun(
  on: On,
  mode: RunMode,
  project: Project,
  body: SupervisorInterviewRequest | undefined,
  deps: RunnerDeps,
  setKey: (key: string | null) => void,
): Promise<{ provider: SupervisorProvider; context: string; bytes: number }> {
  if (isInContainer(deps.env)) throw new SupervisorError("KEYCHAIN_UNAVAILABLE", { vars: { inContainer: true } });
  const key =
    on.provider === "claude"
      ? await requireKey("claude", deps.keychain)
      : await readKey("openai-compatible", deps.keychain);
  setKey(key);
  const base = on.provider === "openai-compatible" ? checkBaseUrl(on.baseUrl ?? "") : null;
  if (base && !base.ok) throw new SupervisorError("CONFIG_INVALID", { vars: { problem: "base-url" } });
  const built =
    mode === "review"
      ? await buildReviewContext(project.projectPath)
      : await buildInterviewContext(project.projectPath, body?.featurePrompt ?? "", body?.developerAnswers);
  const model = on.model ?? "";
  const provider =
    on.provider === "claude"
      ? new ClaudeProvider({ apiKey: key!, model, baseURL: deps.anthropicBaseUrl, timeoutMs: deps.timeoutMs })
      : new OpenAICompatibleProvider({
          baseUrl: base?.ok ? base.url : "",
          apiKey: key,
          model,
          timeoutMs: deps.timeoutMs,
        });
  return { provider, context: built.text, bytes: built.bytes };
}

/** Runs one plan or explain with the provider `resolved` names, and writes its run-log line, success or not. */
export async function runSupervisor(o: {
  mode: RunMode;
  project: Project;
  resolved: Exclude<ResolvedSupervisor, { state: "off" }>;
  body?: SupervisorInterviewRequest;
  deps: RunnerDeps;
}): Promise<SupervisorResult | ReviewResult> {
  const started = Date.now();
  const on = o.resolved.state === "on" ? o.resolved : null;
  const line: RunLogLine = {
    event: "supervisor_run",
    provider: on?.provider ?? null,
    model: on?.model ?? null,
    project_id: o.project.id,
    mode: o.mode,
    duration_ms: 0,
    outcome: "ok",
    context_bytes: null,
  };
  let key: string | null = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.deps.timeoutMs);
  try {
    if (!on) {
      const problem = o.resolved.state === "invalid" ? o.resolved.problem : "invalid";
      throw new SupervisorError("CONFIG_INVALID", { vars: { problem } });
    }
    let provider: SupervisorProvider = o.project.codex;
    let context: string | undefined;
    if (on.provider !== "codex") {
      const prepared = await prepareApiRun(on, o.mode, o.project, o.body, o.deps, (k) => (key = k));
      provider = prepared.provider;
      context = prepared.context;
      line.context_bytes = prepared.bytes;
    }
    const ctx = { projectPath: o.project.projectPath, model: on.model, signal: controller.signal, context };
    return o.mode === "review"
      ? await provider.review(ctx)
      : await provider.interview(o.body?.featurePrompt ?? "", o.body?.developerAnswers, ctx);
  } catch (err) {
    const failure = asSupervisorError(err, key);
    line.outcome = failure.code;
    if (failure.detail) line.error_detail = scrub(failure.detail, key);
    throw failure;
  } finally {
    clearTimeout(timer);
    line.duration_ms = Date.now() - started;
    o.deps.logSink(formatRunLog(line));
  }
}
