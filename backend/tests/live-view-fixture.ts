import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const CLI_SCHEMA = readFileSync(join(import.meta.dirname, "fixtures", "cli-schema.sql"), "utf8");

export interface SeedEvent {
  sequenceNum?: number;
  eventType?: string;
  toolName?: string | null;
  toolInput?: unknown;
  toolOutput?: unknown;
  /** Stores the output the way the CLI stores a large one: a blob reference in the row. */
  blobOriginalSize?: number;
  verdict?: string | null;
  reason?: string | null;
  ruleId?: string | null;
  createdAt?: number;
}

export interface SeedUsage {
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd: number;
  unknownModel?: boolean;
  turns?: number;
}

export interface AuditDb {
  dir: string;
  dbPath: string;
  db: DatabaseSync;
  seedSession(
    id: string,
    o?: { agent?: string; transcriptPath?: string; metadataJson?: string; startedAt?: number },
  ): void;
  /** Returns the new row's rowid. */
  seedEvent(sessionId: string, e?: SeedEvent): number;
  seedEvents(sessionId: string, n: number, make?: (i: number) => SeedEvent): number[];
  seedUsage(sessionId: string, rows: SeedUsage[]): void;
  cleanup(): void;
}

/** Which parts of today's schema an older agentdock-cli did not create yet. Every part is there by default. */
export interface SchemaParts {
  /** `session_usage` (cost per session and model). */
  withUsage?: boolean;
  /** `events.rule_id` (the rule behind a decision). */
  withRuleId?: boolean;
  withCreatedAtIndex?: boolean;
}

/** Creates the CLI's tables in `db` from `fixtures/cli-schema.sql`, the one copy of them in this repo. */
export function applyCliSchema(db: DatabaseSync, o: SchemaParts = {}): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(CLI_SCHEMA);
  if (o.withUsage === false) db.exec("DROP TABLE session_usage;");
  if (o.withCreatedAtIndex === false) db.exec("DROP INDEX idx_events_created_at;");
  if (o.withRuleId === false) db.exec("ALTER TABLE events DROP COLUMN rule_id;");
}

/** One table's CREATE statement from the fixture, for a test where the table appears while the backend runs. */
export function cliTable(name: string): string {
  const m = new RegExp(String.raw`CREATE TABLE IF NOT EXISTS ${name} \([\s\S]*?\n\);`).exec(CLI_SCHEMA);
  if (!m) throw new Error(`fixtures/cli-schema.sql has no table ${name}`);
  return m[0];
}

/** A project folder with `.ctrlplane/audit.db` laid out exactly as the CLI writes it (`fixtures/cli-schema.sql`). */
export function createAuditDb(o: SchemaParts = {}): AuditDb {
  const dir = mkdtempSync(join(tmpdir(), "agentdock-live-"));
  mkdirSync(join(dir, ".ctrlplane"));
  const dbPath = join(dir, ".ctrlplane", "audit.db");
  const db = new DatabaseSync(dbPath);
  applyCliSchema(db, o);

  const nextSeq = new Map<string, number>();
  let clock = 1_763_450_000_000;

  const seedEvent = (sessionId: string, e: SeedEvent = {}): number => {
    const seq = e.sequenceNum ?? (nextSeq.get(sessionId) ?? 0) + 1;
    nextSeq.set(sessionId, Math.max(seq, nextSeq.get(sessionId) ?? 0));
    const output =
      e.blobOriginalSize !== undefined
        ? JSON.stringify({ _blob_ref: "ab".repeat(32), original_size: e.blobOriginalSize })
        : e.toolOutput === undefined
          ? null
          : JSON.stringify(e.toolOutput);
    const result = db
      .prepare(
        `INSERT INTO events (id, session_id, sequence_num, event_type, tool_name, tool_input_json, tool_output_json,
           is_blob_stored, policy_verdict, policy_reason, execution_duration_ms, created_at, rule_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 3, ?, ?)`,
      )
      .run(
        `evt_${sessionId}_${seq}_${Math.random().toString(36).slice(2, 8)}`,
        sessionId,
        seq,
        e.eventType ?? "pre_tool",
        e.toolName === undefined ? "Bash" : e.toolName,
        e.toolInput === undefined ? JSON.stringify({ command: `echo ${seq}` }) : JSON.stringify(e.toolInput),
        output,
        e.blobOriginalSize !== undefined ? 1 : 0,
        e.verdict === undefined ? "ALLOW" : e.verdict,
        e.reason ?? null,
        e.createdAt ?? clock++,
        e.ruleId ?? null,
      );
    return Number(result.lastInsertRowid);
  };

  return {
    dir,
    dbPath,
    db,
    seedSession(id, s = {}) {
      const metadata =
        s.metadataJson ?? (s.transcriptPath ? JSON.stringify({ transcriptPath: s.transcriptPath }) : null);
      db.prepare(
        `INSERT INTO sessions (id, agent_type, project_path, git_branch, base_commit_sha, status, started_at, metadata_json)
         VALUES (?, ?, ?, 'main', 'abc', 'active', ?, ?)`,
      ).run(id, s.agent ?? "claude-code", dir, s.startedAt ?? clock++, metadata);
    },
    seedEvent,
    seedEvents(sessionId, n, make = () => ({})) {
      const ids: number[] = [];
      db.exec("BEGIN;");
      for (let i = 0; i < n; i++) ids.push(seedEvent(sessionId, make(i)));
      db.exec("COMMIT;");
      return ids;
    },
    seedUsage(sessionId, rows) {
      for (const r of rows) {
        db.prepare(
          `INSERT INTO session_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens,
             cache_creation_tokens, cost_usd, unknown_model, turns, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          sessionId,
          r.model,
          r.inputTokens ?? 0,
          r.outputTokens ?? 0,
          r.cacheReadTokens ?? 0,
          r.cacheCreationTokens ?? 0,
          r.costUsd,
          r.unknownModel ? 1 : 0,
          r.turns ?? 1,
          clock++,
        );
      }
    },
    cleanup() {
      try {
        db.close();
      } catch {
        // Already closed by the test.
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
