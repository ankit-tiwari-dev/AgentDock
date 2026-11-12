import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentDockBackendServer } from "../src/server.ts";

/** Raw GET, so the path reaches the server exactly as written (fetch would clean it up first). */
function get(port: number, path: string): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method: "GET" }, (res) => {
      const parts: Buffer[] = [];
      res.on("data", (c: Buffer) => parts.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(parts).toString() }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

const INLINE = "self.__next_f=self.__next_f||[]";

function exportDir() {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-out-"));
  mkdirSync(join(dir, "_next"));
  writeFileSync(
    join(dir, "index.html"),
    `<!DOCTYPE html><html><head><script src="/_next/app.js"></script></head><body><script>${INLINE}</script></body></html>`,
  );
  writeFileSync(join(dir, "_next", "app.js"), "console.log(1)");
  return dir;
}

async function withServer(fn: (port: number) => Promise<void>) {
  const staticRoot = exportDir();
  const server = new AgentDockBackendServer({ port: 0, staticRoot });
  const { port } = await server.start();
  try {
    await fn(port);
  } finally {
    await server.stop();
    rmSync(staticRoot, { recursive: true, force: true });
  }
}

test("regression: a malformed percent-escape gets 400 and the backend keeps running", async () => {
  await withServer(async (port) => {
    assert.equal((await get(port, "/%")).status, 400);
    assert.equal((await get(port, "/_next/%E0%A4%A")).status, 400);
    assert.equal((await get(port, "/api/health")).status, 200);
  });
});

test("an encoded ../ cannot read files outside the dashboard export", async () => {
  await withServer(async (port) => {
    for (const path of ["/..%2f..%2fpackage.json", "/%2e%2e/%2e%2e/package.json", "/..%5c..%5cpackage.json"]) {
      const res = await get(port, path);
      assert.equal(res.status, 404, path);
      assert.equal(res.body.includes('"workspaces"'), false, path);
    }
  });
});

test("the dashboard page is served with a policy that only runs its own scripts", async () => {
  await withServer(async (port) => {
    const page = await get(port, "/");
    assert.equal(page.status, 200);
    const csp = String(page.headers["content-security-policy"]);
    const hash = createHash("sha256").update(INLINE).digest("base64");
    assert.match(csp, /default-src 'self'/);
    assert.ok(csp.includes(`'sha256-${hash}'`), csp);
    assert.equal(/script-src[^;]*'unsafe-inline'/.test(csp), false, csp);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    const script = await get(port, "/_next/app.js");
    assert.equal(script.status, 200);
    assert.match(String(script.headers["content-type"]), /javascript/);
  });
});

test("inline scripts are found exactly as written, and scripts with a src are skipped", async () => {
  const { inlineScripts } = await import("../src/static-files.ts");
  const html = `<SCRIPT>a()</SCRIPT><script src="/x.js"></script><script type="application/json" id="d">{"k":1}</script ><script async src=/y.js></script><script>b()`;
  assert.deepEqual(inlineScripts(html), ["a()", '{"k":1}']);
});
