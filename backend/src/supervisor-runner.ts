import type { Project } from "./projects.ts";
import type { ResolvedSupervisor } from "./provider-resolver.ts";
import { formatRunLog, type RunLogLine } from "./run-log.ts";
import { SupervisorError, scrub, type RunMode } from "./supervisor-provider.ts";
import type { ReviewResult, SupervisorResult } from "./supervisor-schemas.ts";
import type { SupervisorInterviewRequest } from "./types.ts";

export interface RunnerDeps {
  timeoutMs: number;
  logSink: (line: string) => void;
}

function asSupervisorError(err: unknown): SupervisorError {
  if (err instanceof SupervisorError) return err;
  // A provider that throws something else still reaches the browser only as fixed text.
  return new SupervisorError("CODEX_FAILED", {
    detail: scrub(err instanceof Error ? err.message : String(err), null),
    vars: { started: true, exitCode: null },
  });
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.deps.timeoutMs);
  try {
    if (o.resolved.state === "invalid") {
      throw new SupervisorError("CONFIG_INVALID", { vars: { problem: o.resolved.problem } });
    }
    const ctx = { projectPath: o.project.projectPath, model: o.resolved.model, signal: controller.signal };
    const provider = o.project.codex;
    return o.mode === "review"
      ? await provider.review(ctx)
      : await provider.interview(o.body?.featurePrompt ?? "", o.body?.developerAnswers, ctx);
  } catch (err) {
    const failure = asSupervisorError(err);
    line.outcome = failure.code;
    if (failure.detail) line.error_detail = scrub(failure.detail, null);
    throw failure;
  } finally {
    clearTimeout(timer);
    line.duration_ms = Date.now() - started;
    o.deps.logSink(formatRunLog(line));
  }
}
