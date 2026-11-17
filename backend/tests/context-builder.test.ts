import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_CAP_BYTES, buildInterviewContext, buildReviewContext } from "../src/context-builder.ts";

function repo(fn: (dir: string, git: (...args: string[]) => string) => Promise<void>, commit = true) {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-ctx-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@agentdock.local");
  git("config", "user.name", "AgentDock test");
  git("config", "core.autocrlf", "false");
  writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
  git("add", ".");
  if (commit) git("commit", "-qm", "init");
  return fn(dir, git).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("the interview context holds the prompt, the answers and the picked project's git ls-files list", async () => {
  await repo(async (dir) => {
    const first = await buildInterviewContext(dir, "Add Google login");
    assert.match(first.text, /FEATURE REQUEST:\nAdd Google login/);
    assert.match(first.text, /REPOSITORY FILES \(1 of 1\):\napp\.ts/);
    assert.equal(first.text.includes("USER ANSWERS"), false);
    assert.equal(first.bytes, Buffer.byteLength(first.text, "utf8"));
    const final = await buildInterviewContext(dir, "Add Google login", { q1: "Google only" });
    assert.match(final.text, /USER ANSWERS \(JSON\):\n\{"q1":"Google only"\}/);
  });
});

test("the review context holds git status --porcelain, git diff HEAD and untracked file names but not their contents", async () => {
  await repo(async (dir) => {
    writeFileSync(join(dir, "app.ts"), "export const a = 2;\n");
    writeFileSync(join(dir, "notes.txt"), "UNTRACKED-CONTENT-MARKER\n");
    const { text } = await buildReviewContext(dir);
    assert.match(text, /GIT STATUS:\n M app\.ts\n\?\? notes\.txt/);
    assert.match(text, /GIT DIFF HEAD:\n[\s\S]*-export const a = 1;\n\+export const a = 2;/);
    assert.match(text, /UNTRACKED FILES:\nnotes\.txt/);
    assert.equal(text.includes("UNTRACKED-CONTENT-MARKER"), false);
  });
});

test("a repo with no commits yet shows its staged changes", async () => {
  await repo(async (dir) => {
    const { text } = await buildReviewContext(dir);
    assert.match(text, /\+export const a = 1;/);
  }, false);
});

test("a context over 200 KB stops with a message naming its size and the cap", async () => {
  await repo(async (dir, git) => {
    writeFileSync(join(dir, "big.txt"), "line of text that changes\n".repeat(10_000));
    git("add", "big.txt");
    await assert.rejects(buildReviewContext(dir), (err: Error & { code?: string }) => {
      assert.equal(err.code, "CONTEXT_TOO_LARGE");
      assert.match(
        err.message,
        /^The changes are \d+ KB; the limit is 200 KB\. Commit or stash part of them and try again\.$/,
      );
      assert.ok(Number(/are (\d+) KB/.exec(err.message)![1]) > CONTEXT_CAP_BYTES / 1024);
      return true;
    });
    await assert.rejects(buildInterviewContext(dir, "x".repeat(CONTEXT_CAP_BYTES)), {
      code: "CONTEXT_TOO_LARGE",
      message: /^The request and file list are \d+ KB; the limit is 200 KB\. Shorten the description and try again\.$/,
    });
  });
});

test("an Anthropic or OpenAI key added in the diff is replaced by the redacted placeholder", async () => {
  await repo(async (dir) => {
    const anthropic = `sk-ant-api03-${"A1b2C3d4".repeat(6)}`;
    const openai = `sk-proj-${"Z9y8X7w6".repeat(5)}`;
    writeFileSync(join(dir, "app.ts"), `export const a = "${anthropic}";\nexport const b = "${openai}";\n`);
    const { text } = await buildReviewContext(dir);
    assert.equal(text.includes(anthropic.slice(14)), false);
    assert.equal(text.includes(openai.slice(9)), false);
    assert.match(text, /\[REDACTED_SECRET:/);
  });
});

test("regression: git runs without a shell, so a file named with $(…) or ; is only a name", async () => {
  await repo(async (dir, git) => {
    const name = "$(touch pwned); touch pwned2";
    writeFileSync(join(dir, name), "x\n");
    git("add", "--", name);
    const { text } = await buildInterviewContext(dir, "x");
    assert.ok(text.includes(name));
    assert.equal(existsSync(join(dir, "pwned")) || existsSync(join(dir, "pwned2")), false);
  });
});

test("a repo with 5,000 tracked files sends the first 2,000 names and the total count", async () => {
  await repo(async (dir, git) => {
    const blob = git("hash-object", "-w", "app.ts").trim();
    const lines = Array.from({ length: 4_999 }, (_, i) => `100644 ${blob}\tsrc/f${String(i).padStart(4, "0")}.ts`);
    execFileSync("git", ["update-index", "--index-info"], { cwd: dir, input: `${lines.join("\n")}\n` });
    const { text } = await buildInterviewContext(dir, "x");
    assert.match(text, /REPOSITORY FILES \(2000 of 5000\):/);
    const listed = text.slice(text.indexOf("REPOSITORY FILES")).split("\n").slice(1).filter(Boolean);
    assert.equal(listed.length, 2_000);
  });
});

test("regression: a repo's core.fsmonitor setting does not run a program while the context is built", async () => {
  await repo(async (dir, git) => {
    const marker = join(dir, "fsmonitor-ran");
    const hook = join(dir, "fsmon.sh");
    writeFileSync(hook, `#!/bin/sh\necho ran > "${marker.replaceAll("\\", "/")}"\n`, { mode: 0o755 });
    git("config", "core.fsmonitor", hook.replaceAll("\\", "/"));
    writeFileSync(join(dir, "app.ts"), "export const a = 3;\n");
    await buildReviewContext(dir);
    await buildInterviewContext(dir, "x");
    assert.equal(existsSync(marker), false);
  });
});

test("a folder that is not a git repository gives GIT_FAILED", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-nogit-"));
  try {
    await assert.rejects(buildReviewContext(dir), {
      code: "GIT_FAILED",
      message: "Could not read the project's git state. Is the project folder a git repository?",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
