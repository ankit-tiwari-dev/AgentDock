import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentDockBackendServer } from "../src/server.ts";

interface SendOptions {
  method: string;
  path: string;
  headers?: Record<string, string>;
  chunks?: Buffer[];
}

interface SendResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(port: number, options: SendOptions): Promise<SendResult> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", port, method: options.method, path: options.path, headers: options.headers },
      (res) => {
        const parts: Buffer[] = [];
        res.on("data", (chunk: Buffer) => parts.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    for (const chunk of options.chunks ?? []) req.write(chunk);
    req.end();
  });
}

/** Sends a WebSocket upgrade and reports the status line the server answered with, or "closed". */
function upgrade(port: number, path: string, origin?: string): Promise<string> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      // The sample nonce from RFC 6455, encoded here so it does not look like a stored secret.
      "Sec-WebSocket-Key": Buffer.from("the sample nonce").toString("base64"),
    };
    if (origin) headers.Origin = origin;
    const req = request({ host: "127.0.0.1", port, path, headers });
    req.on("upgrade", (res, socket) => {
      socket.destroy();
      resolve(String(res.statusCode));
    });
    req.on("response", (res) => {
      res.resume();
      resolve(String(res.statusCode));
    });
    req.on("error", () => resolve("closed"));
    req.end();
  });
}

async function withServer(run: (port: number) => Promise<void>): Promise<void> {
  const server = new AgentDockBackendServer({ port: 0 });
  const { port } = await server.start();
  try {
    await run(port);
  } finally {
    await server.stop();
  }
}

const json = (value: unknown) => [Buffer.from(JSON.stringify(value))];

test("regression: responses never send a wildcard CORS header", async () => {
  await withServer(async (port) => {
    const res = await send(port, { method: "GET", path: "/api/health", headers: { Origin: "https://evil.example" } });
    assert.equal(res.headers["access-control-allow-origin"], undefined);
  });
});

test("regression: a cross-site POST is rejected", async () => {
  await withServer(async (port) => {
    const res = await send(port, {
      method: "POST",
      path: "/api/events/broadcast",
      headers: { Origin: "https://evil.example", "Content-Type": "application/json" },
      chunks: json({ type: "spec_updated", sessionId: "s", timestamp: 1, data: {} }),
    });
    assert.equal(res.status, 403);
  });
});

test("regression: a text/plain POST is rejected, so a plain HTML form cannot reach the API", async () => {
  await withServer(async (port) => {
    const res = await send(port, {
      method: "POST",
      path: "/api/coach/analyze",
      headers: { "Content-Type": "text/plain" },
      chunks: json({ prompt: "fix the login bug in src/auth.ts" }),
    });
    assert.equal(res.status, 415);
  });
});

test("regression: a request whose Host is not this machine is rejected (DNS rebinding)", async () => {
  await withServer(async (port) => {
    const res = await send(port, { method: "GET", path: "/api/health", headers: { Host: `evil.example:${port}` } });
    assert.equal(res.status, 403);
  });
});

test("same-origin and no-origin POSTs are accepted", async () => {
  await withServer(async (port) => {
    const variants: Array<Record<string, string>> = [
      { Origin: `http://127.0.0.1:${port}`, "Content-Type": "application/json" },
      { Origin: `http://localhost:${port}`, "Content-Type": "application/json; charset=utf-8" },
      { "Content-Type": "application/json" },
    ];
    for (const headers of variants) {
      const res = await send(port, {
        method: "POST",
        path: "/api/coach/analyze",
        headers,
        chunks: json({ prompt: "fix it" }),
      });
      assert.equal(res.status, 200, JSON.stringify(headers));
    }
  });
});

test("regression: a WebSocket upgrade from another site is refused", async () => {
  await withServer(async (port) => {
    assert.notEqual(await upgrade(port, "/ws/events", "https://evil.example"), "101");
    assert.equal(await upgrade(port, "/ws/events", `http://127.0.0.1:${port}`), "101");
    assert.equal(await upgrade(port, "/ws/events"), "101");
  });
});

test("regression: a WebSocket path with a query string is accepted", async () => {
  await withServer(async (port) => {
    assert.equal(await upgrade(port, "/ws/events?x=1"), "101");
  });
});

test("regression: a body over 1 MB is rejected with 413", async () => {
  await withServer(async (port) => {
    const big = Buffer.from(JSON.stringify({ prompt: "a".repeat(1024 * 1024 + 10) }));
    const res = await send(port, {
      method: "POST",
      path: "/api/coach/analyze",
      headers: { "Content-Type": "application/json", "Content-Length": String(big.length) },
      chunks: [big],
    });
    assert.equal(res.status, 413);
  });
});

test("regression: a character split across two chunks arrives intact", async () => {
  await withServer(async (port) => {
    const payload = Buffer.from(JSON.stringify({ prompt: "fix the café menu in src/menu.ts" }));
    const split = payload.indexOf(0xc3) + 1; // between the two bytes of "é"
    const res = await send(port, {
      method: "POST",
      path: "/api/coach/analyze",
      headers: { "Content-Type": "application/json" },
      chunks: [payload.subarray(0, split), payload.subarray(split)],
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).prompt, "fix the café menu in src/menu.ts");
  });
});

test("regression: invalid JSON gets a 400 that says so", async () => {
  await withServer(async (port) => {
    const res = await send(port, {
      method: "POST",
      path: "/api/coach/analyze",
      headers: { "Content-Type": "application/json" },
      chunks: [Buffer.from("{not json")],
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.body).error, "Invalid JSON body");
  });
});

test("regression: the cost endpoint prices a current model at its own rate", async () => {
  await withServer(async (port) => {
    const res = await send(port, {
      method: "POST",
      path: "/api/cost/calculate",
      headers: { "Content-Type": "application/json" },
      chunks: json({ modelName: "claude-opus-5-5", inputTokens: 1_000_000, outputTokens: 0 }),
    });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).costUsd, 4);
  });
});
