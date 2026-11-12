import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const srcDir = join(import.meta.dirname, "..", "src");

function sources(dir: string): { path: string; text: string }[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => {
      const path = join(entry.parentPath, entry.name);
      return { path, text: readFileSync(path, "utf8") };
    });
}

test("regression: the dashboard never builds HTML out of server or event data", () => {
  // React escapes text it renders. These are the ways around that, and event data is not trusted.
  for (const { path, text } of sources(srcDir)) {
    assert.equal(/dangerouslySetInnerHTML|\.innerHTML\s*=|\.outerHTML\s*=|insertAdjacentHTML/.test(text), false, path);
  }
});

test("regression: the connection badge does not claim the daemon is connected", () => {
  // The page talks to the backend's WebSocket. Nothing tells it whether a daemon is running.
  for (const { path, text } of sources(srcDir)) assert.equal(/daemon connected/i.test(text), false, path);
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
