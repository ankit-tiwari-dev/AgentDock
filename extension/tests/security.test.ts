import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { SecretManager } from "../src/secret-manager.ts";
import { AgentDockSidebarProvider } from "../src/sidebar-provider.ts";
import type { SecretStorageLike } from "../src/types.ts";

class MemorySecretStorage implements SecretStorageLike {
  private values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key);
  }
  async store(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

/** A port that was free a moment ago, so a connection to it is refused. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return typeof address === "object" && address ? address.port : 1;
}

const provider = (port = 45820) => new AgentDockSidebarProvider(new SecretManager(new MemorySecretStorage()), port);

test("regression: the webview has a Content Security Policy that only runs its own script", () => {
  const html = provider().getHtmlForWebview();
  const csp = /<meta http-equiv="Content-Security-Policy" content="([^"]+)">/.exec(html);
  assert.ok(csp, "missing CSP meta tag");
  assert.match(csp[1], /default-src 'none'/);
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp[1])?.[1];
  assert.ok(nonce, "script-src must use a nonce");
  const scripts = [...html.matchAll(/<script([^>]*)>/g)].map((m) => m[1]);
  assert.deepEqual(scripts, [` nonce="${nonce}"`]);
  // Inline handlers are blocked by that policy, so the page must not depend on them.
  assert.equal(/\son[a-z]+="/i.test(html), false);
});

test("regression: each webview gets a fresh nonce", () => {
  const p = provider();
  assert.notEqual(p.getHtmlForWebview(), p.getHtmlForWebview());
});

test("regression: the webview never builds HTML out of backend data", () => {
  const html = provider().getHtmlForWebview();
  const assignments = [...html.matchAll(/\.innerHTML\s*=\s*([^;]+)/g)].map((m) => m[1].trim());
  assert.deepEqual(
    assignments.filter((value) => value !== "''"),
    [],
  );
});

test("regression: with the backend offline, no specification is made up", async () => {
  const p = provider(await closedPort());
  const sent: Array<Record<string, unknown>> = [];
  await p.handleMessage({ type: "submit_answers", prompt: "Add login", answers: { Q1: "a" } }, (msg) =>
    sent.push(msg as Record<string, unknown>),
  );
  await p.handleMessage({ type: "start_interview", prompt: "Add login" }, (msg) =>
    sent.push(msg as Record<string, unknown>),
  );
  assert.deepEqual(
    sent.map((msg) => msg.type),
    ["backend_offline", "backend_offline"],
  );
  assert.equal(JSON.stringify(sent).includes("mock"), false);
});

test("regression: the key field does not suggest a key format from another provider", () => {
  assert.equal(provider().getHtmlForWebview().includes("(sk-...)"), false);
});
