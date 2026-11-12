import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentDockBackendServer } from "../src/server.ts";
import type { ReviewResult, SupervisorResult } from "../src/codex-role-service.ts";

/** Stands in for Codex CLI. Counts calls, and `hold` keeps a run going until released. */
function fakeCodex() {
  const calls = { interview: 0, review: 0 };
  let release: () => void = () => {};
  let hold = false;
  const wait = () => (hold ? new Promise<void>((r) => (release = r)) : Promise.resolve());
  return {
    calls,
    holdNextRun() {
      hold = true;
    },
    release: () => release(),
    service: {
      async interview(): Promise<SupervisorResult> {
        calls.interview++;
        await wait();
        return { isRefined: false, clarificationQuestions: [] };
      },
      async review(): Promise<ReviewResult> {
        calls.review++;
        await wait();
        return { summary: "from codex", changes: [], testsAndEvidence: [], risks: [], nextSteps: [] };
      },
    },
  };
}

function post(port: number, path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "Content-Type": "application/json" } },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (c: Buffer) => parts.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(parts).toString()) }));
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

async function withServer(codexEnabled: boolean, fn: (port: number, fake: ReturnType<typeof fakeCodex>) => Promise<void>) {
  const fake = fakeCodex();
  const server = new AgentDockBackendServer({ port: 0, codexEnabled, codexRoles: fake.service });
  const { port } = await server.start();
  try {
    await fn(port, fake);
  } finally {
    await server.stop();
  }
}

test("with Codex off, the explainer says how to turn it on and never starts Codex", async () => {
  await withServer(false, async (port, fake) => {
    const res = await post(port, "/api/reviewer/explain", {});
    assert.equal(res.status, 503);
    assert.match(String(res.json.error), /AGENTDOCK_CODEX=1/);
    assert.equal(fake.calls.review, 0);
  });
});

test("with Codex off, the guide answers with the built-in interview", async () => {
  await withServer(false, async (port, fake) => {
    const res = await post(port, "/api/supervisor/interview", { featurePrompt: "Add Google login" });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.json.clarificationQuestions) && res.json.clarificationQuestions.length > 0);
    assert.equal(fake.calls.interview, 0);
  });
});

test("with Codex on, the guide and the explainer use Codex", async () => {
  await withServer(true, async (port, fake) => {
    assert.equal((await post(port, "/api/supervisor/interview", { featurePrompt: "x" })).status, 200);
    const review = await post(port, "/api/reviewer/explain", {});
    assert.equal(review.json.summary, "from codex");
    assert.deepEqual(fake.calls, { interview: 1, review: 1 });
  });
});

test("only one Codex run at a time; a second request gets 409", async () => {
  await withServer(true, async (port, fake) => {
    fake.holdNextRun();
    const first = post(port, "/api/reviewer/explain", {});
    while (fake.calls.review === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await post(port, "/api/supervisor/interview", { featurePrompt: "x" });
    assert.equal(second.status, 409);
    fake.release();
    assert.equal((await first).status, 200);
    assert.equal(fake.calls.interview, 0);
  });
});

test("the health check tells the dashboard whether Codex is on", async () => {
  for (const enabled of [false, true]) {
    await withServer(enabled, async (port) => {
      const health = (await (await fetch(`http://127.0.0.1:${port}/api/health`)).json()) as { codexEnabled: boolean };
      assert.equal(health.codexEnabled, enabled);
    });
  }
});
