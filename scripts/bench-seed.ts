/**
 * Builds a synthetic audit.db for the live-view benchmark: 100,000 events over 200 sessions (one session with 10,000),
 * laid out as agentdock-cli writes it (backend/tests/fixtures/cli-schema.sql), with the created_at index and two
 * cost rows per session.
 * Run: node scripts/bench-seed.ts <out.db>
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const out = process.argv[2];
if (!out) throw new Error("usage: node scripts/bench-seed.ts <out.db>");
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(out + suffix)) rmSync(out + suffix);

const db = new DatabaseSync(out);
db.exec("PRAGMA journal_mode = WAL;");
db.exec(readFileSync(join(import.meta.dirname, "..", "backend", "tests", "fixtures", "cli-schema.sql"), "utf8"));

const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "WebFetch"];
const VERDICTS = ["ALLOW", "ALLOW", "ALLOW", "ALLOW", "DENY", "REQUIRE_MANUAL_APPROVAL", "INSTRUCT"];
const AGENTS = ["claude-code", "codex", "opencode"];
const TYPES = ["pre_tool", "post_tool", "pre_tool", "post_tool", "user_prompt", "stop"];
const filler = (n: number, seed: number) => {
  const words = ["build", "test", "src", "module", "handler", "config", "result", "status", "value", "item"];
  let text = "";
  for (let i = 0; text.length < n; i++) text += `${words[(seed + i * 7) % words.length]}-${(seed * 31 + i) % 997} `;
  return text;
};

const insertSession = db.prepare(
  `INSERT INTO sessions (id, agent_type, project_path, git_branch, base_commit_sha, status, started_at, metadata_json)
   VALUES (?, ?, '/bench', 'main', 'abc', 'completed', ?, ?)`,
);
const insertEvent = db.prepare(
  `INSERT INTO events (id, session_id, sequence_num, event_type, tool_name, tool_input_json, tool_output_json,
     is_blob_stored, policy_verdict, policy_reason, execution_duration_ms, created_at, rule_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);

const insertUsage = db.prepare(
  `INSERT INTO session_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     cost_usd, unknown_model, turns, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
);

const start = 1_760_000_000_000;
let n = 0;
db.exec("BEGIN;");
for (let s = 0; s < 200; s++) {
  const id = `bench-${s}`;
  insertSession.run(
    id,
    AGENTS[s % AGENTS.length],
    start + s * 60_000,
    JSON.stringify({ transcriptPath: `/t/${id}.jsonl` }),
  );
  insertUsage.run(id, "claude-opus-4-5", 1200 + s, 800 + s, 90_000, 4000, 0.4 + s / 1000, 20, start);
  insertUsage.run(id, "claude-haiku-4-5", 300 + s, 100 + s, 5000, 0, 0.01, 6, start);
  const count = s === 0 ? 10_000 : Math.round(90_000 / 199) + (s <= 90_000 % 199 ? 1 : 0);
  for (let i = 1; i <= count; i++) {
    n++;
    const tool = TOOLS[n % TOOLS.length];
    const type = TYPES[n % TYPES.length];
    const blob = n % 97 === 0;
    const input = JSON.stringify(
      tool === "Bash"
        ? { command: `npm run ${filler(60, n)}` }
        : { file_path: `C:\\work\\app\\src\\${filler(30, n)}.ts` },
    );
    const output = blob
      ? JSON.stringify({ _blob_ref: "ab".repeat(32), original_size: 120_000 })
      : type === "post_tool"
        ? JSON.stringify({ stdout: filler(1500, n) })
        : null;
    const verdict = type === "pre_tool" ? VERDICTS[n % VERDICTS.length] : null;
    insertEvent.run(
      `evt_${n}`,
      id,
      i,
      type,
      tool,
      input,
      output,
      blob ? 1 : 0,
      verdict,
      verdict && verdict !== "ALLOW" ? `Rule matched: ${filler(40, n)}` : null,
      3,
      start + n * 1000,
      verdict && verdict !== "ALLOW" ? `rule.${n % 13}` : null,
    );
  }
}
// One needle near the oldest end, so a search for it has to scan almost everything.
db.prepare("UPDATE events SET tool_input_json = ? WHERE id = 'evt_5'").run(
  JSON.stringify({ command: "grep needle-zz9 ." }),
);
db.exec("COMMIT;");
db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
db.close();
console.log(JSON.stringify({ out, events: n, sessions: 200 }));
