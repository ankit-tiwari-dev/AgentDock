import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const html = readFileSync(join(import.meta.dirname, "..", "public", "index.html"), "utf8");

test("regression: the dashboard never builds HTML out of server or event data", () => {
  // Clearing a list (`innerHTML = ''`) is fine. Anything else must use textContent / createElement,
  // because event data and interview answers are not trusted.
  const assignments = [...html.matchAll(/\.innerHTML\s*=\s*([^;]+)/g)].map((m) => m[1].trim());
  const unsafe = assignments.filter((value) => value !== "''" && value !== '""');
  assert.deepEqual(unsafe, []);
});

test("regression: the connection badge does not claim the daemon is connected", () => {
  // The page talks to the backend's WebSocket. Nothing tells it whether a daemon is running.
  assert.equal(html.includes("Daemon Connected"), false);
});

test("regression: every entry point named in a workspace package.json exists", () => {
  for (const workspace of ["backend", "frontend", "extension"]) {
    const dir = join(import.meta.dirname, "..", "..", workspace);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
      main?: string;
      types?: string;
      exports?: Record<string, string>;
    };
    for (const entry of [manifest.main, manifest.types, ...Object.values(manifest.exports ?? {})]) {
      if (entry) assert.equal(existsSync(join(dir, entry)), true, `${workspace}: ${entry}`);
    }
  }
});
