import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseSupervisorFile, type ParseProblem, type ProviderName } from "./supervisor-config.ts";

export type ResolvedSupervisor =
  | { state: "off" }
  | { state: "invalid"; problem: ParseProblem }
  | { state: "on"; provider: ProviderName; model: string | null; baseUrl: string | null; source: "config" | "env" };

const CODEX_FROM_ENV: ResolvedSupervisor = {
  state: "on",
  provider: "codex",
  model: null,
  baseUrl: null,
  source: "env",
};

export function supervisorHome(env: Record<string, string | undefined>, configured?: string): string {
  return configured ?? env.CTRLPLANE_HOME ?? join(homedir(), ".ctrlplane");
}

export function isInContainer(env: Record<string, string | undefined>): boolean {
  return env.AGENTDOCK_IN_CONTAINER === "1";
}

/**
 * Read on every run, so `ctrlplane supervisor use` applies without a restart. An explicit override wins, then
 * `supervisor.json`, then `AGENTDOCK_CODEX=1`. A file that exists but cannot be used is never replaced by a fallback,
 * so a typo cannot quietly change which provider runs.
 */
export function resolveSupervisor(o: {
  home: string;
  env: Record<string, string | undefined>;
  codexEnabledOverride?: boolean;
}): ResolvedSupervisor {
  if (o.codexEnabledOverride !== undefined) return o.codexEnabledOverride ? CODEX_FROM_ENV : { state: "off" };
  const path = join(o.home, "supervisor.json");
  if (existsSync(path)) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      return { state: "invalid", problem: "json" };
    }
    const parsed = parseSupervisorFile(text);
    if (!parsed.ok) return { state: "invalid", problem: parsed.problem };
    const file = parsed.value;
    return {
      state: "on",
      provider: file.provider,
      model: file.model ?? null,
      baseUrl: file.openaiCompatible?.baseUrl ?? null,
      source: "config",
    };
  }
  return o.env.AGENTDOCK_CODEX === "1" ? CODEX_FROM_ENV : { state: "off" };
}
