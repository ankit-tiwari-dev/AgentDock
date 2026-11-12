import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
}

export interface DashboardSnapshot {
  source: { projectPath: string; databasePath: string; available: boolean };
  events: DashboardEvent[];
  sessions: DashboardSession[];
  counts: { toolCalls: number; blockedCalls: number; reviewCalls: number; activeSessions: number; totalEvents: number };
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

const EVENT_COLUMNS = `
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
    // The daemon records an observe-mode hit as an ALLOW whose reason says what it would have done.
    observedOnly: decision === "ALLOW" && (reason?.startsWith("Observe mode:") ?? false),
    latencyMs: latency === null || latency === undefined ? undefined : num(latency),
  };
}

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

  public snapshot(now = Date.now()): DashboardSnapshot {
    const events = this.query(
      `SELECT ${EVENT_COLUMNS} FROM events e LEFT JOIN sessions s ON s.id = e.session_id ORDER BY e.rowid DESC LIMIT ?`,
      SNAPSHOT_LIMIT,
    ).map(toEvent);

    const sessions = this.query(
      `SELECT s.id, s.agent_type, s.project_path, s.status, s.started_at, s.ended_at,
              coalesce(max(e.created_at), s.started_at) AS last_activity,
              coalesce(sum(e.event_type = 'pre_tool'), 0) AS tool_calls,
              coalesce(sum(e.event_type = 'pre_tool' AND e.policy_verdict = 'DENY'), 0) AS blocked_calls
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
      };
    });

    const [totals] = this.query(
      `SELECT coalesce(sum(event_type = 'pre_tool'), 0) AS tool_calls,
              coalesce(sum(event_type = 'pre_tool' AND policy_verdict = 'DENY'), 0) AS blocked,
              coalesce(sum(event_type = 'pre_tool' AND policy_verdict = 'REQUIRE_MANUAL_APPROVAL'), 0) AS review,
              count(*) AS total
         FROM events`,
    );

    return {
      source: { projectPath: this.projectPath, databasePath: this.databasePath, available: this.open() !== undefined },
      events,
      sessions,
      counts: {
        toolCalls: num(totals?.tool_calls),
        blockedCalls: num(totals?.blocked),
        reviewCalls: num(totals?.review),
        activeSessions: sessions.filter((s) => s.status === "active").length,
        totalEvents: num(totals?.total),
      },
    };
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
      `SELECT ${EVENT_COLUMNS} FROM events e LEFT JOIN sessions s ON s.id = e.session_id
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
