export type ProviderName = "codex" | "claude" | "openai-compatible";
export type KeyProvider = "claude" | "openai-compatible";

/** `GET /api/supervisor/settings`. It never holds a key, only whether one is saved. */
export type SettingsView = {
  provider: ProviderName | null;
  model: string | null;
  baseUrl: string | null;
  source: "config" | "env" | "none";
  /** `null` means the keychain cannot be read here (Docker). */
  keys: Record<KeyProvider, boolean | null>;
  writable: boolean;
  writableReason?: string;
  configProblem?: string;
};

/** `GET /api/supervisor/models?provider=`. */
export type ModelList = { models: string[]; freeText: boolean; current: string | null };

/** The `supervisor` field of `GET /api/health`. */
export type SupervisorHealth = {
  provider: ProviderName | null;
  model: string | null;
  keySaved: boolean | null;
  ready: boolean;
};

export const PROVIDER_LABEL: Record<ProviderName, string> = {
  codex: "Codex",
  claude: "Claude",
  "openai-compatible": "OpenAI-compatible",
};

export const KEY_PROVIDERS: readonly KeyProvider[] = ["claude", "openai-compatible"];

export function settingsView(
  s: SettingsView,
  models: ModelList | null,
): {
  providerLabel: string;
  modelOptions: string[];
  keyRows: Array<{ provider: KeyProvider; label: "Yes" | "No" | "Not readable"; showCommand: boolean }>;
  canSave: boolean;
  reason?: string;
} {
  const listed = models?.models ?? [];
  // A saved model the provider no longer lists must still be the selected option, not silently replaced.
  const current = models?.current;
  const modelOptions = current && !listed.includes(current) ? [current, ...listed] : listed;
  return {
    providerLabel: s.provider ? PROVIDER_LABEL[s.provider] : "None",
    modelOptions,
    keyRows: KEY_PROVIDERS.map((provider) => {
      const saved = s.keys[provider];
      const label = saved === null ? "Not readable" : saved ? "Yes" : "No";
      return { provider, label, showCommand: saved === false };
    }),
    canSave: s.writable,
    ...(s.writable ? {} : { reason: s.writableReason }),
  };
}

/** The provider whose model list the page needs, or null; a save's new settings object must not refetch it. */
export function modelListFor(picked: ProviderName, view: SettingsView | null): ProviderName | null {
  // The list is fetched with the saved key, so without one the request can only fail.
  return view && picked !== "codex" && view.keys[picked] ? picked : null;
}

/** Ready means a click in Plan & review would start a model call. */
export function supervisorStatus(s: SettingsView): { good: boolean; text: string } {
  if (s.configProblem) return { good: false, text: `Not ready. ${s.configProblem}` };
  if (!s.provider) return { good: false, text: "Off. Plan & review uses the built-in supervisor." };
  if (s.provider === "claude") {
    if (s.keys.claude === null) {
      return {
        good: false,
        text: "Not ready. The container cannot read the host keychain, so the Claude key is not available.",
      };
    }
    if (!s.keys.claude) {
      return { good: false, text: "Not ready. No Claude key saved. Run: ctrlplane supervisor set-key claude" };
    }
  }
  if (s.provider === "openai-compatible" && s.keys["openai-compatible"] === null) {
    return {
      good: false,
      text: "Not ready. The container cannot read the host keychain, so the OpenAI-compatible key is not available.",
    };
  }
  return { good: true, text: "Ready" };
}

export function supervisorLabel(h: SupervisorHealth | null): string {
  if (!h?.provider) return "Supervisor: built-in";
  return `Supervisor: ${PROVIDER_LABEL[h.provider]}, ${h.model ?? "default model"}`;
}
