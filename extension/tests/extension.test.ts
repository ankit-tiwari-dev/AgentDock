import test from "node:test";
import assert from "node:assert/strict";
import { SecretManager } from "../src/secret-manager.ts";
import { AgentDockSidebarProvider } from "../src/sidebar-provider.ts";
import type { SecretStorageLike } from "../src/types.ts";

class MockSecretStorage implements SecretStorageLike {
  private storeMap: Map<string, string> = new Map();

  async get(key: string): Promise<string | undefined> {
    return this.storeMap.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeMap.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.storeMap.delete(key);
  }
}

test("SecretManager securely stores and checks Gemini & Claude keys", async () => {
  const mockStorage = new MockSecretStorage();
  const manager = new SecretManager(mockStorage);

  assert.equal(await manager.hasKeyForProvider("gemini"), false);

  await manager.setGeminiKey("sk-gemini-test-secret-key-12345");
  assert.equal(await manager.hasKeyForProvider("gemini"), true);
  assert.equal(await manager.getGeminiKey(), "sk-gemini-test-secret-key-12345");

  await manager.setClaudeKey("sk-ant-test-secret-key-67890");
  assert.equal(await manager.hasKeyForProvider("claude"), true);

  await manager.clearKeys();
  assert.equal(await manager.hasKeyForProvider("gemini"), false);
  assert.equal(await manager.hasKeyForProvider("claude"), false);
});

test("SidebarProvider generates HTML and dispatches messages", async () => {
  const mockStorage = new MockSecretStorage();
  const manager = new SecretManager(mockStorage);
  const provider = new AgentDockSidebarProvider(manager, 45820);

  // 1. Verify Webview HTML output
  const html = provider.getHtmlForWebview();
  assert.ok(html.includes("AgentDock Supervisor"));
  assert.ok(html.includes("Socratic Product Guide"));
  assert.ok(html.includes("AI Model Configuration"));

  // 2. Test message dispatch: ready
  let dispatchedMsg: any = null;
  await provider.handleMessage({ type: "ready" }, (msg) => {
    dispatchedMsg = msg;
  });

  assert.equal(dispatchedMsg?.type, "status_update");
  assert.equal(dispatchedMsg?.hasGemini, false);
  assert.equal(dispatchedMsg?.backendPort, 45820);

  // 3. Test message dispatch: save_api_key
  await provider.handleMessage(
    { type: "save_api_key", provider: "gemini", key: "sk-gemini-new-key-123" },
    (msg) => {
      dispatchedMsg = msg;
    }
  );

  assert.equal(dispatchedMsg?.type, "key_saved");
  assert.equal(await manager.getGeminiKey(), "sk-gemini-new-key-123");
});

