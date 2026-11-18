import test from "node:test";
import assert from "node:assert/strict";
import { randomInt } from "node:crypto";
import { AgentDockBackendServer } from "../src/server.ts";
import { redactObject, redactSecrets } from "../src/redactor.ts";
import { createAuditDb } from "./live-view-fixture.ts";

/** A GitHub-style token made fresh for each run, so no key is ever committed. */
function plantedKey(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const body = Array.from({ length: 36 }, () => alphabet[randomInt(alphabet.length)]).join("");
  return ["gh", "p_"].join("") + body;
}

test("regression: a planted key in a Bash command and its output is found by the command word and the redaction marker, never by the key itself, comes back redacted, and no search or timeline response holds the full key, metadata_json or transcriptPath", async () => {
  const key = plantedKey();
  const a = createAuditDb();
  try {
    a.seedSession("s1", { transcriptPath: "/home/dev/.claude/projects/p/s1.jsonl" });
    // Written the way the CLI's insertEvent writes: input, output and reason pass through the redactor first.
    const input = redactObject({ command: `git push https://${key}@github.com/acme/app.git deploy-zebra` });
    const output = redactObject({ stderr: `remote: token ${key} accepted` });
    const reason = redactSecrets(`Push with token ${key} needs review`).sanitized;
    a.seedEvent("s1", { toolInput: input, toolOutput: output, reason, verdict: "REQUIRE_MANUAL_APPROVAL" });
    a.seedEvents("s1", 5);
    assert.ok(
      !a.db
        .prepare("SELECT group_concat(tool_input_json || tool_output_json || policy_reason) AS t FROM events")
        .get()
        ?.t?.toString()
        .includes(key),
    );

    const server = new AgentDockBackendServer({ port: 0, projectPaths: [a.dir] });
    const { port } = await server.start();
    try {
      const base = `http://127.0.0.1:${port}`;
      const bodies: string[] = [];
      for (const q of ["deploy-zebra", "REDACTED_SECRET:GITHUB_TOKEN"]) {
        const res = await fetch(`${base}/api/events/search?q=${encodeURIComponent(q)}`);
        assert.equal(res.status, 200);
        const text = await res.text();
        bodies.push(text);
        const { events } = JSON.parse(text) as { events: { toolInput: { command: string } }[] };
        assert.equal(events.length, 1, q);
        assert.ok(events[0].toolInput.command.includes("[REDACTED_SECRET:GITHUB_TOKEN]"));
      }
      // The key was redacted before it was stored, so its own text, even its start, finds nothing.
      for (const q of [key.slice(0, 10), key]) {
        const res = await fetch(`${base}/api/events/search?q=${encodeURIComponent(q)}`);
        const text = await res.text();
        assert.equal((JSON.parse(text) as { events: unknown[] }).events.length, 0);
        bodies.push(text);
      }
      const timeline = await fetch(`${base}/api/sessions/s1/timeline`);
      bodies.push(await timeline.text());
      for (const body of bodies) {
        assert.ok(!body.includes(key), "full key in a response");
        assert.ok(!body.includes(key.slice(4, 20)), "part of the key in a response");
        assert.ok(!body.includes("metadata"), "metadata in a response");
        assert.ok(!body.includes("transcriptPath"), "transcript path in a response");
      }
    } finally {
      await server.stop();
    }
  } finally {
    a.cleanup();
  }
});
