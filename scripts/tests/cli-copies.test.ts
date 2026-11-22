import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { COPIES, body, foreignImports, header, main } from "../cli-copies.ts";

function write(root: string, path: string, text: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test("body strips the copy header and the blank line after it, only from .ts copies", () => {
  assert.equal(body("a.ts", header("packages/x.ts", "abc1234") + "export const a = 1;\n"), "export const a = 1;\n");
  assert.equal(body("a.ts", "export const a = 1;\n"), "export const a = 1;\n");
  assert.equal(body("a.json", '{"a":1}'), '{"a":1}');
});

test("foreignImports lists every import that is not a node: built-in", () => {
  const text =
    'import { a } from "node:fs";\nimport { b } from "../../core/src/index.ts";\nimport type { C } from "./c.ts";\n';
  assert.deepEqual(foreignImports(text), ["../../core/src/index.ts", "./c.ts"]);
});

test("regression: a copy that missed an upstream fix fails, --sync repairs it, and a package import cannot be copied", () => {
  // token-pricing.ts kept a quadratic regex for weeks after agentdock-cli fixed it (4d20642).
  const dir = mkdtempSync(join(tmpdir(), "cli-copies-"));
  const cli = join(dir, "agentdock-cli");
  const dock = join(dir, "agentdock");
  const git = (...args: string[]) => execFileSync("git", ["-C", cli, ...args], { stdio: "ignore" });
  try {
    mkdirSync(cli);
    git("init", "-q", "-b", "main");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    git("config", "core.autocrlf", "false");
    for (const { copy, source } of COPIES) {
      const text = copy.endsWith(".ts") ? `export const v = "${source}";\n` : "{}\n";
      write(cli, source, text);
      write(dock, copy, copy.endsWith(".ts") ? header(source, "old") + text : text);
    }
    git("add", ".");
    git("commit", "-q", "-m", "base");
    assert.equal(main(["--cli", cli, "--root", dock]), 0);

    write(cli, COPIES[3].source, 'export const v = "fixed upstream";\n');
    git("commit", "-q", "-am", "fix");
    assert.equal(main(["--cli", cli, "--root", dock]), 1);
    assert.equal(main(["--cli", cli, "--root", dock, "--sync"]), 0);
    assert.match(readFileSync(join(dock, COPIES[3].copy), "utf8"), /fixed upstream/);
    assert.equal(main(["--cli", cli, "--root", dock]), 0);

    write(cli, COPIES[0].source, 'import { x } from "../../core/src/index.ts";\nexport const v = x;\n');
    git("commit", "-q", "-am", "import");
    assert.equal(main(["--cli", cli, "--root", dock]), 2);
    assert.equal(main(["--cli", join(dir, "missing"), "--root", dock]), 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
