import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentDockBackendServer, parseDevOrigin } from "../src/server.ts";

function call(port: number, method: string, path: string, origin: string, body?: string) {
  return new Promise<{ status: number; allow: unknown }>((resolve, reject) => {
    const headers: Record<string, string> = { Origin: origin };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (method === "OPTIONS") headers["Access-Control-Request-Method"] = "POST";
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0, allow: res.headers["access-control-allow-origin"] }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function withServer(devOrigin: string | undefined, fn: (port: number) => Promise<void>) {
  const server = new AgentDockBackendServer({ port: 0, devOrigin, codexEnabled: false });
  const { port } = await server.start();
  try {
    await fn(port);
  } finally {
    await server.stop();
  }
}

const coach = JSON.stringify({ prompt: "Add a login page" });

test("without a dev origin, the Next.js dev port is just another website", async () => {
  await withServer(undefined, async (port) => {
    const post = await call(port, "POST", "/api/coach/analyze", "http://localhost:3000", coach);
    assert.equal(post.status, 403);
    assert.equal(post.allow, undefined);
    assert.equal((await call(port, "OPTIONS", "/api/coach/analyze", "http://localhost:3000")).status, 403);
  });
});

test("the named dev origin may call the API and read the answer; no other origin may", async () => {
  await withServer("http://localhost:3000", async (port) => {
    const preflight = await call(port, "OPTIONS", "/api/coach/analyze", "http://localhost:3000");
    assert.equal(preflight.status, 204);
    assert.equal(preflight.allow, "http://localhost:3000");
    const post = await call(port, "POST", "/api/coach/analyze", "http://localhost:3000", coach);
    assert.equal(post.status, 200);
    assert.equal(post.allow, "http://localhost:3000");
    const other = await call(port, "POST", "/api/coach/analyze", "http://localhost:3001", coach);
    assert.equal(other.status, 403);
    assert.equal(other.allow, undefined);
  });
});

test("only a plain http address on this machine can be named as the dev origin", () => {
  assert.equal(parseDevOrigin("http://localhost:3000"), "http://localhost:3000");
  assert.equal(parseDevOrigin("HTTP://127.0.0.1:3000"), "http://127.0.0.1:3000");
  for (const bad of [
    "https://evil.example",
    "http://localhost.evil.example:3000",
    "*",
    "http://localhost:3000/",
    "null",
  ]) {
    assert.equal(parseDevOrigin(bad), undefined, bad);
  }
});
