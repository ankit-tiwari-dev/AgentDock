import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { type Harness, KEYS, withApiBackend } from "./supervisor-api-harness.ts";

/** Node's fetch may drop a browser-only header such as Origin, so these go through node:http. */
function get(h: Harness, path: string, headers: Record<string, string>): Promise<number> {
  const url = new URL(path, h.base);
  return new Promise((resolve, reject) => {
    const req = request({ host: url.hostname, port: url.port, path: url.pathname + url.search, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

async function paths(h: Harness): Promise<string[]> {
  const { projects } = (await (await fetch(`${h.base}/api/projects`)).json()) as { projects: Array<{ id: string }> };
  const project = projects[0].id;
  return [
    "/api/supervisor/models?provider=openai-compatible",
    "/api/supervisor/settings",
    `/api/dashboard/state?project=${project}`,
    `/api/events/search?project=${project}`,
  ];
}

const FOREIGN: Array<Record<string, string>> = [
  { Origin: "https://evil.example" },
  { Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
  { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "no-cors" },
  { "Sec-Fetch-Site": "same-site", "Sec-Fetch-Mode": "no-cors" },
];

test("regression: a cross-site GET is refused before it reads the keychain or calls the provider", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("openai-compatible");
    for (const path of await paths(h)) {
      for (const headers of FOREIGN)
        assert.equal(await get(h, path, headers), 403, `${path} ${JSON.stringify(headers)}`);
    }
    assert.equal(h.keychainCalls(), 0);
    assert.equal(h.fake.calls.length, 0);
  });
});

test("same-origin, direct and non-browser GETs still pass the gate", async () => {
  await withApiBackend({ keys: KEYS }, async (h) => {
    h.use("openai-compatible");
    const own = h.base;
    const allowed: Array<Record<string, string>> = [
      {},
      { Origin: own, "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
      { "Sec-Fetch-Site": "same-origin", "Sec-Fetch-Mode": "cors" },
      { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate" },
    ];
    for (const path of await paths(h)) {
      for (const headers of allowed)
        assert.equal(await get(h, path, headers), 200, `${path} ${JSON.stringify(headers)}`);
    }
  });
});

test("regression: a link from another site still opens the dashboard page, but not an API route", async () => {
  await withApiBackend({}, async (h) => {
    const navigate = { "Sec-Fetch-Site": "cross-site", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" };
    assert.notEqual(await get(h, "/", navigate), 403);
    assert.equal(await get(h, "/api/supervisor/settings", navigate), 403);
    assert.equal(h.keychainCalls(), 0);
  });
});
