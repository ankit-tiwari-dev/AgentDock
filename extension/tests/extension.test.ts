import test from "node:test";
import assert from "node:assert/strict";
import { activateExtension } from "../src/extension.ts";
import { AgentDockSidebarProvider } from "../src/sidebar-provider.ts";

test("activateExtension builds the sidebar provider", () => {
  const { sidebarProvider } = activateExtension({ subscriptions: [] });
  assert.ok(sidebarProvider instanceof AgentDockSidebarProvider);
  assert.ok(sidebarProvider.getHtmlForWebview().includes("AgentDock Supervisor"));
});

test("SidebarProvider generates HTML and dispatches messages", async () => {
  const provider = new AgentDockSidebarProvider(45820);

  // 1. Verify Webview HTML output
  const html = provider.getHtmlForWebview();
  assert.ok(html.includes("AgentDock Supervisor"));
  assert.ok(html.includes("Socratic Product Guide"));
  assert.ok(html.includes("AI Model Configuration"));

  // 2. Test message dispatch: ready
  let dispatchedMsg = null as Record<string, unknown> | null;
  await provider.handleMessage({ type: "ready" }, (msg) => {
    dispatchedMsg = msg as Record<string, unknown>;
  });

  assert.equal(dispatchedMsg?.type, "status_update");
  assert.equal(dispatchedMsg?.backendPort, 45820);
  // The extension cannot know whether the CLI saved a key, so it must not report one.
  assert.equal("hasClaude" in (dispatchedMsg ?? {}), false);
  assert.equal("hasGemini" in (dispatchedMsg ?? {}), false);
});

test("regression: the webview offers no API-key box and never claims a key reached the keychain", () => {
  const html = new AgentDockSidebarProvider().getHtmlForWebview();
  assert.equal(/type="password"/i.test(html), false);
  assert.equal(html.includes("save_api_key"), false);
  assert.equal(/saved to the OS keychain/i.test(html), false);
  assert.equal(html.includes("SecretStorage"), false);
  assert.ok(html.includes("ctrlplane supervisor set-key"));
});

test("regression: a save-key message from the webview is ignored", async () => {
  const sent: unknown[] = [];
  const p = new AgentDockSidebarProvider();
  const message = { type: "save_api_key", provider: "claude", key: "sk-ant-test-0000000000" };
  await p.handleMessage(message as unknown as Parameters<typeof p.handleMessage>[0], (msg) => sent.push(msg));
  assert.deepEqual(sent, []);
});
