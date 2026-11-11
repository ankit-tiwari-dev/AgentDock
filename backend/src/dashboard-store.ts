import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { WSEventMessage } from "./types.ts";

export interface DashboardEvent {
  id: string;
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
}

interface DashboardData {
  events: DashboardEvent[];
  sessions: DashboardSession[];
}

const MAX_EVENTS = 5000;
const MAX_SESSIONS = 500;
const TRACKED_TYPES = new Set(["agent_tool_executing", "agent_tool_completed", "agent_session_updated"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export class DashboardStore {
  private readonly filePath: string;
  private data: DashboardData;

  constructor(filePath = process.env.AGENTDOCK_DASHBOARD_STORE || join(process.cwd(), ".agentdock", "dashboard.json")) {
    this.filePath = filePath;
    this.data = this.load();
  }

  public ingest(message: WSEventMessage): DashboardEvent | undefined {
    if (!TRACKED_TYPES.has(message.type) || !isRecord(message.data)) return undefined;
    const data = message.data;
    const hookEventName = text(data.hookEventName);
    if (!hookEventName) return undefined;
    const timestamp = Number.isFinite(message.timestamp) ? message.timestamp : Date.now();
    const sessionId = text(message.sessionId, "unknown");
    const event: DashboardEvent = {
      id: text(data.eventId, `${sessionId}:${hookEventName}:${timestamp}`),
      sessionId,
      timestamp,
      hookEventName,
      agent: text(data.agent, "custom"),
      projectPath: text(data.projectPath),
      toolName: text(data.toolName) || undefined,
      toolInput: data.toolInput,
      toolOutput: data.toolOutput,
      decision: text(data.decision) || undefined,
      reason: text(data.reason) || undefined,
      ruleId: text(data.ruleId) || undefined,
      observedOnly: data.observedOnly === true,
      latencyMs: typeof data.latencyMs === "number" && Number.isFinite(data.latencyMs) ? data.latencyMs : undefined,
    };

    const recorded = this.data.events.find((existing) => existing.id === event.id);
    if (recorded) return recorded;
    this.data.events.unshift(event);
    this.data.events.length = Math.min(this.data.events.length, MAX_EVENTS);
    this.updateSession(event);
    this.persist();
    return event;
  }

  public snapshot() {
    const events = this.data.events.slice(0, 500);
    const sessions = this.data.sessions
      .map((session) => ({
        ...session,
        status: session.status === "completed" ? "completed" : Date.now() - session.lastActivity > 5 * 60_000 ? "idle" : "active",
      }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
    const toolEvents = this.data.events.filter((event) => event.hookEventName === "PreToolUse");
    return {
      events,
      sessions,
      counts: {
        toolCalls: toolEvents.length,
        blockedCalls: toolEvents.filter((event) => event.decision === "DENY").length,
        reviewCalls: toolEvents.filter((event) => event.decision === "REQUIRE_MANUAL_APPROVAL").length,
        activeSessions: sessions.filter((session) => session.status === "active").length,
        totalEvents: this.data.events.length,
      },
    };
  }

  private updateSession(event: DashboardEvent): void {
    const existing = this.data.sessions.find((session) => session.id === event.sessionId);
    const ended = event.hookEventName === "SessionEnd";
    if (existing) {
      existing.agent = event.agent || existing.agent;
      existing.projectPath = event.projectPath || existing.projectPath;
      existing.lastActivity = event.timestamp;
      if (event.hookEventName === "SessionStart" && existing.status === "completed") {
        existing.startedAt = event.timestamp;
        existing.toolCalls = 0;
        existing.blockedCalls = 0;
      }
      existing.status = ended ? "completed" : "active";
      if (event.hookEventName === "PreToolUse") {
        existing.toolCalls++;
        if (event.decision === "DENY") existing.blockedCalls++;
      }
      return;
    }
    this.data.sessions.unshift({
      id: event.sessionId,
      agent: event.agent,
      projectPath: event.projectPath,
      status: ended ? "completed" : "active",
      startedAt: event.hookEventName === "SessionStart" ? event.timestamp : event.timestamp,
      lastActivity: event.timestamp,
      toolCalls: event.hookEventName === "PreToolUse" ? 1 : 0,
      blockedCalls: event.hookEventName === "PreToolUse" && event.decision === "DENY" ? 1 : 0,
    });
    this.data.sessions.length = Math.min(this.data.sessions.length, MAX_SESSIONS);
  }

  private load(): DashboardData {
    if (!existsSync(this.filePath)) return { events: [], sessions: [] };
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (!isRecord(parsed) || !Array.isArray(parsed.events) || !Array.isArray(parsed.sessions)) return { events: [], sessions: [] };
      return {
        events: parsed.events.filter(isRecord) as unknown as DashboardEvent[],
        sessions: parsed.sessions.filter(isRecord) as unknown as DashboardSession[],
      };
    } catch {
      return { events: [], sessions: [] };
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.data), { encoding: "utf8", mode: 0o600 });
    renameSync(temporary, this.filePath);
  }
}
