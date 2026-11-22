import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { jsonEscapedText, likePattern, type SearchQuery, type TimelineQuery } from "./event-query.ts";

/**
 * Reads a project's `.ctrlplane/audit.db`, the file the agentdock-cli daemon writes on every hook call.
 * The connection is read-only: the dashboard can show the audit trail but never change it.
 * Inputs and outputs were redacted by the CLI before they were stored.
 */

export interface DashboardEvent {
  id: string;
  rowId: number;
  sessionId: string;
  timestamp: number;
  hookEventName: string;
  agent: string;
  projectPath: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  decision?: string;
  reason?: string;
  /** The rule that decided the call. Audit logs written before agentdock-cli stored it have none. */
  ruleId?: string;
  observedOnly: boolean;
  latencyMs?: number;
}

export interface DashboardSession {
  id: string;
  agent: string;
  projectPath: string;
  status: "active" | "idle" | "completed";
  startedAt: number;
  lastActivity: number;
  toolCalls: number;
  blockedCalls: number;
  /** Token use and cost the CLI recorded for this session; null when it recorded none. */
  usage: UsageTotals | null;
  /** The session has a transcript the CLI could read for cost. The path itself never leaves the reader. */
  hasTranscript: boolean;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  models: string[];
  /** A model was not in the CLI's price list, so its cost is an estimate. */
  estimated: boolean;
}

export interface DashboardSnapshot {
  source: { projectPath: string; databasePath: string; available: boolean };
  events: DashboardEvent[];
  sessions: DashboardSession[];
  counts: {
    toolCalls: number;
    blockedCalls: number;
    reviewCalls: number;
    activeSessions: number;
    totalEvents: number;
    /** Every recorded session in the project, not only the ones in this snapshot. */
    usage: (UsageTotals & { sessions: number }) | null;
    /** False when the CLI that wrote this database does not record cost. */
    usageRecorded: boolean;
  };
  /**
   * The approval requests from the last `windowMs` (D-6), read apart from `events` so newer calls cannot push them
   * out, with the same session's later completions and requests for the same tool that "Ran afterwards" (D-7) needs.
   */
  approvals: { windowMs: number; events: DashboardEvent[] };
}

/** An event from search or the timeline. A large output is stored outside the database and is not sent. */
export interface PublicEvent extends DashboardEvent {
  sequenceNum: number;
  outputStoredSeparately?: { originalSize: number };
}

/** The database exists but could not be read. Carries the SQLite error code only, never SQL text or values. */
export class AuditReadError extends Error {
  public readonly code: string;
  /** A table or column the reader needs is missing, as opposed to a locked or unreadable file. */
  public readonly schemaMismatch: boolean;
  constructor(code: string, schemaMismatch = false) {
    super("The audit database could not be read.");
    this.code = code;
    this.schemaMismatch = schemaMismatch;
  }
}

/** The CLI stores its own event type names; the dashboard shows the agent's hook names. */
const HOOK_NAME: Record<string, string> = {
  pre_tool: "PreToolUse",
  post_tool: "PostToolUse",
  user_prompt: "UserPromptSubmit",
  stop: "Stop",
  subagent_stop: "SubagentStop",
  session_start: "SessionStart",
  session_end: "SessionEnd",
  pre_compact: "PreCompact",
  notification: "Notification",
};

const IDLE_AFTER_MS = 5 * 60_000;
const SNAPSHOT_LIMIT = 500;
const POLL_LIMIT = 500;
/** The audit log does not record whether an approval was answered, so an older request is treated as no longer waiting. */
export const APPROVAL_WINDOW_MS = 15 * 60 * 1000;

const BASE_EVENT_COLUMNS = `
  e.rowid AS row_id, e.id, e.session_id, e.event_type, e.tool_name, e.tool_input_json, e.tool_output_json,
  e.policy_verdict, e.policy_reason, e.execution_duration_ms, e.created_at, s.agent_type, s.project_path`;

type Row = Record<string, unknown>;

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === "bigint" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toEvent(row: Row): DashboardEvent {
  const decision = str(row.policy_verdict);
  const reason = str(row.policy_reason);
  const latency = row.execution_duration_ms;
  return {
    id: String(row.id),
    rowId: num(row.row_id),
    sessionId: String(row.session_id),
    timestamp: num(row.created_at),
    hookEventName: HOOK_NAME[String(row.event_type)] ?? String(row.event_type),
    agent: str(row.agent_type) ?? "unknown",
    projectPath: str(row.project_path) ?? "",
    toolName: str(row.tool_name),
    toolInput: parseJson(row.tool_input_json),
    toolOutput: parseJson(row.tool_output_json),
    decision,
    reason,
    ruleId: str(row.rule_id),
    // The daemon records an observe-mode hit as an ALLOW whose reason says what it would have done.
    observedOnly: decision === "ALLOW" && (reason?.startsWith("Observe mode:") ?? false),
    latencyMs: latency === null || latency === undefined ? undefined : num(latency),
  };
}

function toPublicEvent(row: Row): PublicEvent {
  const event: PublicEvent = { ...toEvent(row), sequenceNum: num(row.sequence_num) };
  if (num(row.is_blob_stored) === 1) {
    const ref = parseJson(row.tool_output_json) as { original_size?: unknown } | undefined;
    return { ...event, toolOutput: null, outputStoredSeparately: { originalSize: num(ref?.original_size) } };
  }
  return event;
}

function sumUsage(rows: Row[]): UsageTotals | null {
  if (rows.length === 0) return null;
  const totals: UsageTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    models: [],
    estimated: false,
  };
  const models = new Set<string>();
  for (const row of rows) {
    totals.inputTokens += num(row.input_tokens);
    totals.outputTokens += num(row.output_tokens);
    totals.cacheReadTokens += num(row.cache_read_tokens);
    totals.cacheCreationTokens += num(row.cache_creation_tokens);
    totals.costUsd += num(row.cost_usd);
    totals.estimated ||= num(row.unknown_model) === 1;
    models.add(String(row.model));
  }
  totals.costUsd = Math.round(totals.costUsd * 1e6) / 1e6;
  totals.models = [...models].sort();
  return totals;
}

const USAGE_COLUMNS = `model, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
  sum(cache_read_tokens) AS cache_read_tokens, sum(cache_creation_tokens) AS cache_creation_tokens,
  sum(cost_usd) AS cost_usd, max(unknown_model) AS unknown_model`;

export class AuditReader {
  public readonly projectPath: string;
  public readonly databasePath: string;
  private db: DatabaseSync | undefined;
  private lastRowId: number | undefined;

  constructor(projectPath: string) {
    this.projectPath = projectPath;
    this.databasePath = join(projectPath, ".ctrlplane", "audit.db");
  }

  /** Opens on first use, so the backend can start before the daemon has created the file. */
  private open(): DatabaseSync | undefined {
    if (this.db) return this.db;
    if (!existsSync(this.databasePath)) return undefined;
    try {
      const db = new DatabaseSync(this.databasePath, { readOnly: true });
      db.exec("PRAGMA busy_timeout = 1000;");
      this.db = db;
      return db;
    } catch {
      return undefined;
    }
  }

  /** The file exists and reads as SQLite; a half-written or foreign file does not count. */
  public available(): boolean {
    const db = this.open();
    if (!db) return false;
    try {
      db.prepare("SELECT count(*) FROM sqlite_master").get();
      return true;
    } catch {
      return false;
    }
  }

  private query(sql: string, ...params: (number | string)[]): Row[] {
    const db = this.open();
    if (!db) return [];
    try {
      return db.prepare(sql).all(...params) as Row[];
    } catch {
      // A half-created file (the daemon has not written its tables yet) or a busy database: show nothing this time.
      return [];
    }
  }

  /** For the live-view routes: a read error is reported, not shown as an empty result. */
  private strictQuery(sql: string, ...params: (number | string)[]): Row[] {
    const db = this.open();
    if (!db) return [];
    try {
      return db.prepare(sql).all(...params) as Row[];
    } catch (err) {
      const { code, message } = (err ?? {}) as { code?: unknown; message?: unknown };
      const missing = typeof message === "string" && /^no such (column|table):/.test(message);
      throw new AuditReadError(typeof code === "string" ? code : "unknown", missing);
    }
  }

  /** Looked up on every read: a newer CLI can create the table while the backend runs. */
  private hasUsageTable(): boolean {
    return this.query("SELECT 1 AS one FROM sqlite_master WHERE type = 'table' AND name = 'session_usage'").length > 0;
  }

  /**
   * The event columns to select. `rule_id` exists only in audit logs from newer agentdock-cli versions, and the CLI
   * may add it while the backend runs, so it is looked up on every read. This connection is read-only and never adds it.
   */
  private eventColumns(): string {
    const hasRuleId = this.query("PRAGMA table_info(events)").some((column) => column.name === "rule_id");
    return `${BASE_EVENT_COLUMNS}, ${hasRuleId ? "e.rule_id" : "NULL"} AS rule_id`;
  }

  /** Throws `AuditReadError` when the file exists but its events, sessions or counts cannot be read. */
  public snapshot(now = Date.now()): DashboardSnapshot {
    const db = this.open();
    if (!db && existsSync(this.databasePath)) throw new AuditReadError("unknown");
    // A file with no tables yet is the daemon starting up, so it reads as empty; after that a failed read is an error.
    const fresh =
      !db || num(this.strictQuery("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'")[0]?.n) === 0;
    const read = fresh ? this.query.bind(this) : this.strictQuery.bind(this);
    const events = read(
      `SELECT ${this.eventColumns()} FROM events e LEFT JOIN sessions s ON s.id = e.session_id ORDER BY e.rowid DESC LIMIT ?`,
      SNAPSHOT_LIMIT,
    ).map(toEvent);

    const sessions = read(
      `SELECT s.id, s.agent_type, s.project_path, s.status, s.started_at, s.ended_at,
              coalesce(max(e.created_at), s.started_at) AS last_activity,
              coalesce(sum(e.event_type = 'pre_tool'), 0) AS tool_calls,
              coalesce(sum(e.event_type = 'pre_tool' AND e.policy_verdict = 'DENY'), 0) AS blocked_calls,
              CASE WHEN json_valid(s.metadata_json)
                   THEN json_extract(s.metadata_json, '$.transcriptPath') IS NOT NULL ELSE 0 END AS has_transcript
         FROM sessions s LEFT JOIN events e ON e.session_id = s.id
        GROUP BY s.id ORDER BY last_activity DESC LIMIT ?`,
      SNAPSHOT_LIMIT,
    ).map((row): DashboardSession => {
      const lastActivity = num(row.last_activity);
      const ended = row.ended_at !== null || row.status === "completed" || row.status === "aborted";
      return {
        id: String(row.id),
        agent: str(row.agent_type) ?? "unknown",
        projectPath: str(row.project_path) ?? "",
        status: ended ? "completed" : now - lastActivity > IDLE_AFTER_MS ? "idle" : "active",
        startedAt: num(row.started_at),
        lastActivity,
        toolCalls: num(row.tool_calls),
        blockedCalls: num(row.blocked_calls),
        usage: null,
        hasTranscript: num(row.has_transcript) === 1,
      };
    });

    const usageRecorded = this.hasUsageTable();
    let projectUsage: DashboardSnapshot["counts"]["usage"] = null;
    if (usageRecorded) {
      if (sessions.length > 0) {
        const rows = this.query(
          `SELECT session_id, ${USAGE_COLUMNS} FROM session_usage
            WHERE session_id IN (${sessions.map(() => "?").join(", ")}) GROUP BY session_id, model`,
          ...sessions.map((session) => session.id),
        );
        const bySession = new Map<string, Row[]>();
        for (const row of rows) {
          const id = String(row.session_id);
          bySession.set(id, [...(bySession.get(id) ?? []), row]);
        }
        for (const session of sessions) session.usage = sumUsage(bySession.get(session.id) ?? []);
      }
      const total = sumUsage(this.query(`SELECT ${USAGE_COLUMNS} FROM session_usage GROUP BY model`));
      const [recorded] = this.query("SELECT count(DISTINCT session_id) AS n FROM session_usage");
      projectUsage = total && { ...total, sessions: num(recorded?.n) };
    }

    const [totals] = read(
      `SELECT coalesce(sum(event_type = 'pre_tool'), 0) AS tool_calls,
              coalesce(sum(event_type = 'pre_tool' AND policy_verdict = 'DENY'), 0) AS blocked,
              coalesce(sum(event_type = 'pre_tool' AND policy_verdict = 'REQUIRE_MANUAL_APPROVAL'), 0) AS review,
              count(*) AS total
         FROM events`,
    );

    const since = now - APPROVAL_WINDOW_MS;
    const approvalEvents = this.query(
      `SELECT ${this.eventColumns()} FROM events e LEFT JOIN sessions s ON s.id = e.session_id
        WHERE e.created_at >= ? AND (e.event_type = 'post_tool' OR e.policy_verdict = 'REQUIRE_MANUAL_APPROVAL')
          AND EXISTS (SELECT 1 FROM events r
                       WHERE r.created_at >= ? AND r.event_type <> 'post_tool'
                         AND r.policy_verdict = 'REQUIRE_MANUAL_APPROVAL' AND r.session_id = e.session_id
                         AND r.tool_name IS e.tool_name AND r.created_at <= e.created_at)
        ORDER BY e.rowid DESC`,
      since,
      since,
    )
      .map(toEvent)
      // "Ran afterwards" looks only at a completion's session, tool, target and time, so its output is not sent.
      .map((event) => (event.hookEventName === "PostToolUse" ? { ...event, toolOutput: undefined } : event));

    return {
      source: { projectPath: this.projectPath, databasePath: this.databasePath, available: this.available() },
      events,
      sessions,
      counts: {
        toolCalls: num(totals?.tool_calls),
        blockedCalls: num(totals?.blocked),
        reviewCalls: num(totals?.review),
        activeSessions: sessions.filter((s) => s.status === "active").length,
        totalEvents: num(totals?.total),
        usage: projectUsage,
        usageRecorded,
      },
      approvals: { windowMs: APPROVAL_WINDOW_MS, events: approvalEvents },
    };
  }

  /** Events matching every given filter, newest first, `limit` at a time; `nextBefore` asks for the next page. */
  public searchEvents(q: SearchQuery): { events: PublicEvent[]; nextBefore: number | null } {
    if (!this.open()) return { events: [], nextBefore: null };
    const hasRuleId = this.query("PRAGMA table_info(events)").some((column) => column.name === "rule_id");
    const where: string[] = [];
    const params: (number | string)[] = [];
    const add = (fragment: string, ...values: (number | string)[]) => {
      where.push(fragment);
      params.push(...values);
    };
    if (q.before !== null) add("e.rowid < ?", q.before);
    if (q.agent !== null) add("s.agent_type = ?", q.agent);
    if (q.verdict !== null) add("e.policy_verdict = ?", q.verdict);
    if (q.tool !== null) add("e.tool_name = ?", q.tool);
    if (q.from !== null) add("e.created_at >= ?", q.from);
    if (q.to !== null) add("e.created_at < ?", q.to);
    if (q.q !== null) {
      // A blob-stored output holds only a reference in the row, so it is not searched.
      const fields = [
        "e.tool_name",
        "e.tool_input_json",
        "CASE WHEN e.is_blob_stored = 0 THEN e.tool_output_json END",
        "e.policy_reason",
        ...(hasRuleId ? ["e.rule_id"] : []),
      ];
      const match = `(${fields.map((field) => `${field} LIKE ? ESCAPE '\\'`).join(" OR ")})`;
      // The stored JSON doubles backslashes and escapes quotes, so a typed C:\Users is also looked for as C:\\Users.
      const patterns = [...new Set([likePattern(q.q), likePattern(jsonEscapedText(q.q))])];
      add(`(${patterns.map(() => match).join(" OR ")})`, ...patterns.flatMap((pattern) => fields.map(() => pattern)));
    }
    const rows = this.strictQuery(
      `SELECT ${this.eventColumns()}, e.sequence_num, e.is_blob_stored
         FROM events e JOIN sessions s ON s.id = e.session_id
        WHERE ${where.length > 0 ? where.join(" AND ") : "1 = 1"}
        ORDER BY e.rowid DESC LIMIT ?`,
      ...params,
      q.limit + 1,
    );
    const events = rows.slice(0, q.limit).map(toPublicEvent);
    return { events, nextBefore: rows.length > q.limit ? events[events.length - 1].rowId : null };
  }

  /**
   * One session's events in order, `limit` at a time; null when this project has no such session. Sequence numbers
   * can repeat within a session, so the order and the `nextAfter` cursor also use the rowid.
   */
  public sessionTimeline(
    sessionId: string,
    q: TimelineQuery,
  ): { events: PublicEvent[]; nextAfter: { sequenceNum: number; rowId: number } | null } | null {
    if (!this.open()) return null;
    if (this.strictQuery("SELECT 1 AS one FROM sessions WHERE id = ?", sessionId).length === 0) return null;
    let cursor = "";
    const params: number[] = [];
    if (q.after !== null && q.afterRow === null) {
      cursor = "AND e.sequence_num > ?";
      params.push(q.after);
    } else if (q.after !== null && q.afterRow !== null) {
      cursor = "AND (e.sequence_num > ? OR (e.sequence_num = ? AND e.rowid > ?))";
      params.push(q.after, q.after, q.afterRow);
    }
    const rows = this.strictQuery(
      `SELECT ${this.eventColumns()}, e.sequence_num, e.is_blob_stored
         FROM events e LEFT JOIN sessions s ON s.id = e.session_id
        WHERE e.session_id = ? ${cursor}
        ORDER BY e.sequence_num, e.rowid LIMIT ?`,
      sessionId,
      ...params,
      q.limit + 1,
    );
    const events = rows.slice(0, q.limit).map(toPublicEvent);
    const last = events[events.length - 1];
    return { events, nextAfter: rows.length > q.limit ? { sequenceNum: last.sequenceNum, rowId: last.rowId } : null };
  }

  /**
   * Events written since the previous call, oldest first. The first call only records where the log ends,
   * so rows that existed before the backend started are not announced as new.
   */
  public poll(): DashboardEvent[] {
    if (this.lastRowId === undefined) {
      const [row] = this.query("SELECT coalesce(max(rowid), 0) AS max_row FROM events");
      if (row === undefined) return [];
      this.lastRowId = num(row.max_row);
      return [];
    }
    const rows = this.query(
      `SELECT ${this.eventColumns()} FROM events e LEFT JOIN sessions s ON s.id = e.session_id
        WHERE e.rowid > ? ORDER BY e.rowid ASC LIMIT ?`,
      this.lastRowId,
      POLL_LIMIT,
    ).map(toEvent);
    if (rows.length > 0) this.lastRowId = rows[rows.length - 1].rowId;
    return rows;
  }

  public close(): void {
    try {
      this.db?.close();
    } catch {
      // Already closed.
    }
    this.db = undefined;
  }
}
