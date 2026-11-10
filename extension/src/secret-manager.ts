import type { SecretStorageLike } from "./types.ts";

export class SecretManager {
  private secrets: SecretStorageLike;

  constructor(secrets: SecretStorageLike) {
    this.secrets = secrets;
  }

  public async getGeminiKey(): Promise<string | undefined> {
    return this.secrets.get("agentdock.geminiApiKey");
  }

  public async setGeminiKey(key: string): Promise<void> {
    await this.secrets.store("agentdock.geminiApiKey", key.trim());
  }

  public async getClaudeKey(): Promise<string | undefined> {
    return this.secrets.get("agentdock.claudeApiKey");
  }

  public async setClaudeKey(key: string): Promise<void> {
    await this.secrets.store("agentdock.claudeApiKey", key.trim());
  }

  public async hasKeyForProvider(provider: "gemini" | "claude"): Promise<boolean> {
    const key = provider === "gemini" ? await this.getGeminiKey() : await this.getClaudeKey();
    return Boolean(key && key.length > 5);
  }

  public async clearKeys(): Promise<void> {
    await this.secrets.delete("agentdock.geminiApiKey");
    await this.secrets.delete("agentdock.claudeApiKey");
  }
}

