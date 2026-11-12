export interface SecretStorageLike {
  get(key: string): Promise<string | undefined>;
  store(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ExtensionConfig {
  modelProvider: "gemini" | "claude" | "ollama";
  modelName: string;
  backendPort: number;
}

export type WebviewMessage =
  | { type: "ready" }
  | { type: "start_interview"; prompt: string }
  | { type: "submit_answers"; prompt: string; answers: Record<string, string> }
  | { type: "run_verification" }
  | { type: "open_browser_dashboard" }
  | { type: "save_api_key"; provider: "gemini" | "claude"; key: string };
