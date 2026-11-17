import { accessSync, constants, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ClaudeProvider } from "./claude-provider.ts";
import { hasKey, readKey, requireKey, type KeyReadOptions } from "./key-reader.ts";
import { OpenAICompatibleProvider } from "./openai-compatible-provider.ts";
import { isInContainer, resolveSupervisor } from "./provider-resolver.ts";
import {
  checkBaseUrl,
  checkModel,
  isProvider,
  supervisorFilePath,
  writeSupervisorFile,
  type ProviderName,
  type SupervisorFile,
} from "./supervisor-config.ts";
import { ERROR_MESSAGES, SupervisorError } from "./supervisor-provider.ts";

/** Everything the dashboard's Settings page shows. It never holds a key, only whether one is saved. */
export interface SettingsView {
  provider: ProviderName | null;
  model: string | null;
  baseUrl: string | null;
  source: "config" | "env" | "none";
  /** `null` means the keychain cannot be read here (Docker). */
  keys: { claude: boolean | null; "openai-compatible": boolean | null };
  writable: boolean;
  writableReason?: string;
  configProblem?: string;
}

export interface SettingsDeps {
  home: string;
  env: Record<string, string | undefined>;
  keychain?: Omit<KeyReadOptions, "inContainer">;
  anthropicBaseUrl?: string;
  timeoutMs: number;
  /** The server's test override for Codex, so Settings and runs resolve the same provider. */
  codexEnabledOverride?: boolean;
}

const resolve = (deps: SettingsDeps) =>
  resolveSupervisor({ home: deps.home, env: deps.env, codexEnabledOverride: deps.codexEnabledOverride });

type SettingsCode =
  "UNKNOWN_FIELD" | "INVALID_PROVIDER" | "INVALID_MODEL" | "BASE_URL_MISSING" | "NOT_CONFIGURED" | "READ_ONLY";
type ErrorBody = { error: string; code: string };

const DOCKER_REASON =
  "Read-only container. Change the supervisor with ctrlplane supervisor on the host. API providers need the host keychain, so they do not run in Docker.";
const HOST_REASON =
  "The backend cannot write the settings file. Change the supervisor with ctrlplane supervisor in a terminal.";
const NOT_CONFIGURED = "Turn the supervisor on first in a terminal: ctrlplane supervisor use <provider> <model>";

const MESSAGES: Record<Exclude<SettingsCode, "READ_ONLY">, string> = {
  UNKNOWN_FIELD: "Only provider and model can be changed here.",
  INVALID_PROVIDER: "Unknown provider.",
  INVALID_MODEL: "The model name is empty, too long or has control characters.",
  BASE_URL_MISSING:
    "Set the base URL first in a terminal: ctrlplane supervisor use openai-compatible <model> --base-url <url>",
  NOT_CONFIGURED,
};

const fail = (status: number, code: Exclude<SettingsCode, "READ_ONLY">) => ({
  status,
  body: { error: MESSAGES[code], code },
});

const filePath = (deps: SettingsDeps) => supervisorFilePath({ CTRLPLANE_HOME: deps.home });

/** Why a save cannot work here, or null when it can. */
function writeProblem(deps: SettingsDeps): string | null {
  if (isInContainer(deps.env)) return DOCKER_REASON;
  const path = filePath(deps);
  if (!existsSync(path)) return NOT_CONFIGURED;
  try {
    accessSync(dirname(path), constants.W_OK);
    accessSync(path, constants.W_OK);
    return null;
  } catch {
    return HOST_REASON;
  }
}

/** Reads the keychain fresh each time; health keeps its own 30 second cache. */
export async function readSettingsView(deps: SettingsDeps): Promise<SettingsView> {
  const resolved = resolve(deps);
  const key = (provider: "claude" | "openai-compatible") =>
    hasKey(provider, { ...deps.keychain, inContainer: isInContainer(deps.env) });
  const [claude, local] = await Promise.all([key("claude"), key("openai-compatible")]);
  const on = resolved.state === "on" ? resolved : null;
  const problem = writeProblem(deps);
  return {
    provider: on?.provider ?? null,
    model: on?.model ?? null,
    baseUrl: on?.baseUrl ?? null,
    source: on?.source ?? (resolved.state === "invalid" ? "config" : "none"),
    keys: { claude, "openai-compatible": local },
    writable: problem === null,
    ...(problem ? { writableReason: problem } : {}),
    ...(resolved.state === "invalid"
      ? { configProblem: ERROR_MESSAGES.CONFIG_INVALID({ problem: resolved.problem }) }
      : {}),
  };
}

/**
 * The only write the backend makes: provider and model in an existing `supervisor.json`. Keys and the base URL are
 * set only with the CLI, so a page in the browser can never point a saved key at another server.
 */
export async function applySettingsChange(
  body: unknown,
  deps: SettingsDeps,
): Promise<{ status: number; body: SettingsView | ErrorBody }> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return fail(400, "UNKNOWN_FIELD");
  const fields = body as Record<string, unknown>;
  if (Object.keys(fields).some((k) => k !== "provider" && k !== "model")) return fail(400, "UNKNOWN_FIELD");
  const { provider, model } = fields;
  if (!isProvider(provider)) return fail(400, "INVALID_PROVIDER");
  const modelOk = typeof model === "string" ? checkModel(model) : provider === "codex" && model === null;
  if (!modelOk) return fail(400, "INVALID_MODEL");
  if (isInContainer(deps.env)) return { status: 503, body: { error: DOCKER_REASON, code: "READ_ONLY" } };
  const path = filePath(deps);
  if (!existsSync(path)) return fail(409, "NOT_CONFIGURED");
  const resolved = resolve(deps);
  // An unreadable file has no base URL to keep; the dashboard may still replace it with provider and model.
  const baseUrl = resolved.state === "on" ? resolved.baseUrl : null;
  if (provider === "openai-compatible" && !baseUrl) return fail(400, "BASE_URL_MISSING");
  const problem = writeProblem(deps);
  if (problem) return { status: 503, body: { error: problem, code: "READ_ONLY" } };
  const next: SupervisorFile = {
    version: 1,
    provider,
    ...(typeof model === "string" ? { model } : {}),
    ...(baseUrl ? { openaiCompatible: { baseUrl } } : {}),
  };
  try {
    writeSupervisorFile(path, next);
  } catch {
    return { status: 503, body: { error: HOST_REASON, code: "READ_ONLY" } };
  }
  return { status: 200, body: await readSettingsView(deps) };
}

/** A free call with the saved key. Codex has no list, so the page offers a text box. */
export async function listModels(
  provider: unknown,
  deps: SettingsDeps,
): Promise<{ status: number; body: { models: string[]; freeText: boolean; current: string | null } | ErrorBody }> {
  if (!isProvider(provider)) return fail(400, "INVALID_PROVIDER");
  const resolved = resolve(deps);
  const on = resolved.state === "on" ? resolved : null;
  const current = on?.provider === provider ? on.model : null;
  if (provider === "codex") return { status: 200, body: { models: [], freeText: true, current } };
  const keyOptions = { ...deps.keychain, inContainer: isInContainer(deps.env) };
  try {
    let models: string[];
    if (provider === "claude") {
      const apiKey = await requireKey("claude", keyOptions);
      models = await new ClaudeProvider({
        apiKey,
        model: current ?? "",
        baseURL: deps.anthropicBaseUrl,
        timeoutMs: deps.timeoutMs,
      }).listModels();
    } else {
      const base = checkBaseUrl(on?.baseUrl ?? "");
      if (!on?.baseUrl || !base.ok) return fail(400, "BASE_URL_MISSING");
      const apiKey = await readKey("openai-compatible", keyOptions);
      models = await new OpenAICompatibleProvider({
        baseUrl: base.url,
        apiKey,
        model: current ?? "",
        timeoutMs: deps.timeoutMs,
      }).listModels();
    }
    return { status: 200, body: { models, freeText: false, current } };
  } catch (err) {
    const failure =
      err instanceof SupervisorError ? err : new SupervisorError("PROVIDER_ERROR", { vars: { status: 0 } });
    return { status: 503, body: failure.body() };
  }
}
