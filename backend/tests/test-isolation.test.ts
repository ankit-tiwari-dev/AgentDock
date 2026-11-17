import test from "node:test";
import assert from "node:assert/strict";
import { AgentDockBackendServer } from "../src/server.ts";

test("regression: tests never read the developer's supervisor settings or turn on a paid supervisor", async () => {
  // A server built without injected settings reads process.env; on a developer's machine that could start a real,
  // paid model run with the real key, sending this repository's diff.
  assert.match(process.env.CTRLPLANE_HOME ?? "", /agentdock-test-home-/);
  for (const name of ["AGENTDOCK_CODEX", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL"]) {
    assert.equal(process.env[name], undefined, name);
  }
  const server = new AgentDockBackendServer({ port: 0 });
  const { port } = await server.start();
  try {
    const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { supervisor: unknown };
    assert.deepEqual(health.supervisor, { provider: null, model: null, keySaved: null, ready: false });
  } finally {
    await server.stop();
  }
});
