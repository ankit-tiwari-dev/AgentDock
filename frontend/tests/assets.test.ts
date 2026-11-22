import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const appDir = join(import.meta.dirname, "..", "src", "app");
const styles = readFileSync(join(appDir, "styles.css"), "utf8");

test("regression: the stylesheet loads nothing from another host", () => {
  assert.equal(/@import/.test(styles), false);
  assert.equal(/url\(\s*["']?(https?:)?\/\//.test(styles), false);
});

test("regression: every font the stylesheet names ships with the dashboard and swaps in", () => {
  const faces = styles.match(/@font-face\s*\{[^}]*\}/g) ?? [];
  const families = new Set(faces.map((face) => /font-family:\s*["']?([^"';]+)/.exec(face)?.[1]));
  assert.deepEqual([...families].sort(), ["Inter", "JetBrains Mono"]);
  for (const face of faces) {
    assert.match(face, /font-display:\s*swap/, face);
    const file = /url\(\s*["']?(\.\/[^"')]+)/.exec(face)?.[1];
    assert.ok(file, face);
    assert.equal(existsSync(join(appDir, file)), true, file);
  }
  assert.equal(existsSync(join(appDir, "fonts", "OFL.txt")), true);
});

test("regression: the dashboard ships an icon, so the browser does not ask for a missing /favicon.ico", () => {
  const icon = readFileSync(join(appDir, "icon.svg"), "utf8");
  assert.match(icon, /^<svg [^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  // The CSP allows images only from the backend itself, so the icon must not pull in anything else.
  assert.equal(/href=|<image|<script/.test(icon), false);
});
