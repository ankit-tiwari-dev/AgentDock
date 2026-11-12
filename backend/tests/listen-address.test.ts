import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { AgentDockBackendServer, parseListenAddress } from "../src/server.ts";

test("with no settings the backend listens on 127.0.0.1:45820, as it always has", () => {
  assert.deepEqual(parseListenAddress({}), { host: "127.0.0.1", port: 45820, loopback: true });
  assert.deepEqual(parseListenAddress({ AGENTDOCK_HOST: "", AGENTDOCK_PORT: "" }), {
    host: "127.0.0.1",
    port: 45820,
    loopback: true,
  });
});

test("a container may listen on every address; only loopback counts as loopback", () => {
  assert.deepEqual(parseListenAddress({ AGENTDOCK_HOST: "0.0.0.0" }), {
    host: "0.0.0.0",
    port: 45820,
    loopback: false,
  });
  assert.deepEqual(parseListenAddress({ AGENTDOCK_HOST: "::" }), { host: "::", port: 45820, loopback: false });
  assert.deepEqual(parseListenAddress({ AGENTDOCK_HOST: "::1", AGENTDOCK_PORT: "8080" }), {
    host: "::1",
    port: 8080,
    loopback: true,
  });
});

test("a network card's address or a host name is refused", () => {
  for (const host of ["192.168.1.20", "10.0.0.5", "localhost", "example.com", "0.0.0.0 "]) {
    const result = parseListenAddress({ AGENTDOCK_HOST: host });
    assert.ok("error" in result, host);
    assert.match(result.error, /AGENTDOCK_HOST/);
  }
});

test("the port must be a whole number from 1 to 65535", () => {
  for (const port of ["0", "65536", "-1", "80.5", "abc", "1e3", "123456"]) {
    const result = parseListenAddress({ AGENTDOCK_PORT: port });
    assert.ok("error" in result, port);
    assert.match(result.error, /AGENTDOCK_PORT/);
  }
  assert.deepEqual(parseListenAddress({ AGENTDOCK_PORT: "1" }), { host: "127.0.0.1", port: 1, loopback: true });
  assert.deepEqual(parseListenAddress({ AGENTDOCK_PORT: "65535" }), { host: "127.0.0.1", port: 65535, loopback: true });
});

function status(port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/api/health", headers: { host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end();
  });
}

test("listening on every address does not loosen the Host check", async () => {
  const server = new AgentDockBackendServer({ host: "0.0.0.0", port: 0, codexEnabled: false });
  const { port } = await server.start();
  try {
    assert.equal(await status(port, `127.0.0.1:${port}`), 200);
    assert.equal(await status(port, `localhost:${port}`), 200);
    // A client on the network can send any Host header; these are the names it would use.
    assert.equal(await status(port, `192.168.1.20:${port}`), 403);
    assert.equal(await status(port, `agentdock.example:${port}`), 403);
    // A port published under a different number than the server's own is refused as well.
    assert.equal(await status(port, `127.0.0.1:${port + 1}`), 403);
  } finally {
    await server.stop();
  }
});
