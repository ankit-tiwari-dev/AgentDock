import type { ProviderName, RunMode, SupervisorCode } from "./supervisor-provider.ts";

/** One line per supervisor run that got past the one-run lock. Never the key, prompt, diff, file list or answer. */
export interface RunLogLine {
  event: "supervisor_run";
  provider: ProviderName | null;
  model: string | null;
  project_id: string;
  mode: RunMode;
  duration_ms: number;
  outcome: "ok" | SupervisorCode;
  context_bytes: number | null;
  error_detail?: string;
}

export function formatRunLog(line: RunLogLine): string {
  return JSON.stringify(line);
}

export const stdoutLogSink = (line: string): void => {
  process.stdout.write(`${line}\n`);
};
