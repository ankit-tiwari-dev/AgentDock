import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseSupervisorFile, type ParseProblem, type ProviderName } from "./supervisor-config.ts";

export type ResolvedSupervisor =
  | { state: "off" }
  | { state: "invalid"; problem: ParseProblem | "home" }
  | { state: "on"; provider: ProviderName; model: string | null; baseUrl: string | null; source: "config" | "env" };

const CODEX_FROM_ENV: ResolvedSupervisor = {
  state: "on",
  provider: "codex",
  model: null,
  baseUrl: null,
  source: "env",
};

/** The path with symlinks resolved as far as it exists, so a link cannot hide that a folder sits in a project. */
function canonical(path: string): string {
  const rest: string[] = [];
  let at = resolve(path);
  for (;;) {
    try {
      return join(realpathSync.native(at), ...rest.reverse());
    } catch {
      const parent = dirname(at);
      if (parent === at) return resolve(path);
      rest.push(basename(at));
      at = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * The folder holding `supervisor.json`: the configured one, else `CTRLPLANE_HOME`, else `~/.ctrlplane` (an empty value
 * counts as unset). null when it must not be read: a relative value resolves inside the folder the backend runs in, and
 * a folder inside a served project is one the agent can write, so either would let the agent pick where the key goes.
 */
export function supervisorHome(
  env: Record<string, string | undefined>,
  configured: string | undefined,
  projectPaths: readonly string[],
): string | null {
  const chosen = configured || env.CTRLPLANE_HOME || join(homedir(), ".ctrlplane");
  if (!isAbsolute(chosen)) return null;
  const real = canonical(chosen);
  return projectPaths.some((project) => isInside(real, canonical(project))) ? null : chosen;
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
  /** null when supervisorHome() refused the folder; the supervisor is then unusable rather than off. */
  home: string | null;
  env: Record<string, string | undefined>;
  codexEnabledOverride?: boolean;
}): ResolvedSupervisor {
  if (o.codexEnabledOverride !== undefined) return o.codexEnabledOverride ? CODEX_FROM_ENV : { state: "off" };
  if (o.home === null) return { state: "invalid", problem: "home" };
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
