// Pure helpers for the dashboard. No React and no imports, so the Node test runner can load this file directly.

export type DashboardEvent = {
  id: string;
  /** The audit row's position; search pages and the "New events" note use it. */
  rowId?: number;
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
};

export type DashboardSession = {
  id: string;
  agent: string;
  projectPath: string;
  status: "active" | "idle" | "completed";
  startedAt: number;
  lastActivity: number;
  toolCalls: number;
  blockedCalls: number;
  /** Token use and cost the CLI recorded; null when it recorded none. */
  usage: UsageTotals | null;
  /** The CLI knows where this session's transcript is, so it can record cost for it. */
  hasTranscript: boolean;
};

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  models: string[];
  /** A model was not in the CLI's price list, so the cost is an estimate. */
  estimated: boolean;
};

export type DashboardSnapshot = {
  source?: { projectPath: string; databasePath: string; available: boolean };
  events: DashboardEvent[];
  sessions: DashboardSession[];
  counts: {
    toolCalls: number;
    blockedCalls: number;
    reviewCalls: number;
    activeSessions: number;
    totalEvents: number;
    /** Every recorded session in the project, not only the ones the snapshot holds. */
    usage: (UsageTotals & { sessions: number }) | null;
    /** False when the CLI that wrote the audit log does not record cost. */
    usageRecorded: boolean;
  };
  approvals: ApprovalWindow;
};

/**
 * The backend reads the approval requests of the last `windowMs` (D-6) apart from the newest events, so a busy agent
 * cannot push one out, with the later events "Ran afterwards" (D-7) compares them with.
 */
export type ApprovalWindow = { windowMs: number; events: DashboardEvent[] };

/** An event from search or the session timeline. A large output is kept outside the database and not sent. */
export type PublicEvent = DashboardEvent & {
  rowId: number;
  sequenceNum: number;
  outputStoredSeparately?: { originalSize: number };
};

export type RuleSummary = {
  id: string;
  count: number;
  latestDecision: string;
  latestReason: string;
  timestamp: number;
  /** How many of the rule's calls got each verdict, keyed by the eventStatus label. */
  counts: Record<string, number>;
  /** The calls the rule acted on, newest first. */
  events: DashboardEvent[];
};

export function eventStatus(event: DashboardEvent): string {
  if (event.hookEventName === "PostToolUse") return isToolFailure(event.toolOutput) ? "Failed" : "Completed";
  if (event.observedOnly) return "Observed";
  if (event.decision === "DENY") return "Blocked";
  if (event.decision === "REQUIRE_MANUAL_APPROVAL") return "Needs approval";
  if (event.decision === "INSTRUCT") return "Guidance";
  return "Allowed";
}

export function isToolFailure(value: unknown): boolean {
  if (!value || typeof value !== "object")
    return typeof value === "string" && /^(error|failed|exception)\b|\bexit code [1-9]/i.test(value);
  const result = value as Record<string, unknown>;
  const code = result.exit_code ?? result.exitCode ?? result.returncode ?? result.status_code;
  return (
    result.is_error === true ||
    result.isError === true ||
    result.success === false ||
    (typeof code === "number" && code !== 0) ||
    Boolean(result.error)
  );
}

export function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}

export function relativeTime(time: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((now - time) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(time).toLocaleString();
}

/**
 * Groups the tool calls a rule acted on. The audit log stores the rule's message but not its ID, so the
 * first line of the message names the group. A plain ALLOW passed every rule and is left out.
 */
export function summarizeRules(events: DashboardEvent[]): RuleSummary[] {
  const rules = new Map<string, RuleSummary>();
  for (const event of events) {
    if (event.hookEventName !== "PreToolUse" || (event.decision === "ALLOW" && !event.observedOnly)) continue;
    const key = event.ruleId ?? event.reason?.split("\n")[0]?.trim();
    if (!key) continue;
    const status = eventStatus(event);
    const current = rules.get(key);
    if (!current) {
      rules.set(key, {
        id: key,
        count: 1,
        latestDecision: status,
        latestReason: event.reason || "",
        timestamp: event.timestamp,
        counts: { [status]: 1 },
        events: [event],
      });
    } else {
      current.count++;
      current.counts[status] = (current.counts[status] ?? 0) + 1;
      current.events.push(event);
      if (event.timestamp > current.timestamp)
        Object.assign(current, {
          latestDecision: eventStatus(event),
          latestReason: event.reason || "",
          timestamp: event.timestamp,
        });
    }
  }
  for (const rule of rules.values()) rule.events.sort((a, b) => b.timestamp - a.timestamp);
  return [...rules.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function statusTone(status: string): string {
  if (status === "Blocked" || status === "DENY" || status === "Failed") return "blocked";
  if (status === "Needs approval" || status === "REQUIRE_MANUAL_APPROVAL" || status === "Observed") return "review";
  if (status === "Guidance" || status === "INSTRUCT") return "guidance";
  return "allowed";
}

export type StreamFilter = "all" | "Blocked" | "Needs approval";

const TARGET_KEYS = ["command", "file_path", "pattern", "path", "url", "query"];

export function eventTarget(event: DashboardEvent): string {
  const input = event.toolInput;
  if (input === undefined || input === null) return "";
  if (typeof input === "object") {
    const fields = input as Record<string, unknown>;
    for (const key of TARGET_KEYS) {
      const value = fields[key];
      if (typeof value === "string" && value) return value;
    }
  }
  return summarize(input);
}

export function streamCounts(events: DashboardEvent[]): { all: number; blocked: number; approval: number } {
  let blocked = 0;
  let approval = 0;
  for (const event of events) {
    const status = eventStatus(event);
    if (status === "Blocked") blocked++;
    else if (status === "Needs approval") approval++;
  }
  return { all: events.length, blocked, approval };
}

export function filterStream(events: DashboardEvent[], filter: StreamFilter, query: string): DashboardEvent[] {
  const needle = query.trim().toLowerCase();
  return events.filter((event) => {
    if (filter !== "all" && eventStatus(event) !== filter) return false;
    if (!needle) return true;
    const haystack = [
      event.toolName || event.hookEventName,
      eventTarget(event),
      event.ruleId,
      event.reason,
      event.agent,
      agentLabel(event.agent),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}

export function recentApprovalRequests(approvals: ApprovalWindow, now = Date.now()): DashboardEvent[] {
  return approvals.events
    .filter((event) => eventStatus(event) === "Needs approval" && now - event.timestamp <= approvals.windowMs)
    .sort((a, b) => b.timestamp - a.timestamp);
}

export function unseenEvents(latest: DashboardEvent[], shown: DashboardEvent[]): DashboardEvent[] {
  const seen = new Set(shown.map((event) => event.id));
  return latest.filter((event) => !seen.has(event.id));
}

const AGENT_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex", opencode: "OpenCode" };

export function agentLabel(agent: string): string {
  return AGENT_NAMES[agent] ?? agent;
}

/** Ids of rows that arrived since the last render. With no earlier rows (the first load) nothing counts as new. */
export function newlyArrived(previous: Set<string> | null, shown: DashboardEvent[]): string[] {
  if (!previous || previous.size === 0) return [];
  return shown.filter((event) => !previous.has(event.id)).map((event) => event.id);
}

export function projectName(path: string | undefined): string {
  return path?.split(/[\\/]/).filter(Boolean).pop() || "No project";
}

/** A project the backend watches, as `GET /api/projects` lists it. */
export type ProjectSummary = { id: string; name: string; projectPath: string; available: boolean };

/** The reason to show when `GET /api/dashboard/state` says the audit log exists but cannot be read; otherwise null. */
export function auditReadProblem(status: number, body: unknown): string | null {
  if (status !== 503) return null;
  const { code, error } = (body ?? {}) as { code?: unknown; error?: unknown };
  if (code !== "DB_UNAVAILABLE" && code !== "SCHEMA_MISMATCH") return null;
  return typeof error === "string" && error !== "" ? error : "The audit database could not be read.";
}

export function projectFromSearch(search: string): string | null {
  return new URLSearchParams(search).get("project");
}

export function projectQuery(id: string | null | undefined): string {
  return id ? `?project=${encodeURIComponent(id)}` : "";
}

/** A message with no project comes from a backend that watches one project, so it is always for the page on screen. */
export function isForProject(message: { project?: string }, shownId: string | null): boolean {
  return !message.project || !shownId || message.project === shownId;
}

export const PAGES = ["overview", "waiting", "sessions", "rules", "plan", "project", "settings"] as const;
export type Page = (typeof PAGES)[number];

/** The Sessions page keeps its search after the page name: `#sessions?q=…`. */
export function pageFromHash(hash: string): Page {
  const name = hash.replace(/^#/, "").split("?")[0];
  return (PAGES as readonly string[]).includes(name) ? (name as Page) : "overview";
}

/**
 * The audit log stores that a call asked for approval, not what the developer answered. A later completed call
 * from the same session with the same tool and target is the only sign the request was allowed; it answers only
 * the newest such request before it, so an earlier, denied request for the same command does not look run.
 */
export function ranAfterwards(request: DashboardEvent, events: DashboardEvent[]): boolean {
  return ranAfterwardsIndex(events)(request);
}

type RanGroup = { askTimes: number[]; askIds: string[]; completions: number[] };

// JSON keeps a "|" in a session id, or a missing tool name, from colliding with another group's key.
const ranKey = (event: DashboardEvent, target: string) =>
  JSON.stringify([event.sessionId, event.toolName ?? null, target]);

/** The first index in an ascending list whose value is at least `time`, or above it when `after` is set. */
function firstAt(times: number[], time: number, after: boolean): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    const value = times[mid] as number;
    if (value < time || (after && value === time)) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * `ranAfterwards` for many requests against one list. Each event's target is read once and the events are grouped
 * by session, tool and target, so each answer is two binary searches instead of two scans of every event.
 */
export function ranAfterwardsIndex(events: DashboardEvent[]): (request: DashboardEvent) => boolean {
  const pending = new Map<string, { asks: DashboardEvent[]; completions: number[] }>();
  for (const event of events) {
    const asks = eventStatus(event) === "Needs approval";
    if (!asks && event.hookEventName !== "PostToolUse") continue;
    const key = ranKey(event, eventTarget(event));
    let group = pending.get(key);
    if (!group) pending.set(key, (group = { asks: [], completions: [] }));
    if (asks) group.asks.push(event);
    else group.completions.push(event.timestamp);
  }
  const groups = new Map<string, RanGroup>();
  for (const [key, { asks, completions }] of pending) {
    if (completions.length === 0) continue;
    asks.sort((a, b) => a.timestamp - b.timestamp);
    groups.set(key, {
      askTimes: asks.map((event) => event.timestamp),
      askIds: asks.map((event) => event.id),
      completions: completions.sort((a, b) => a - b),
    });
  }
  return (request) => {
    const group = groups.get(ranKey(request, eventTarget(request)));
    if (!group) return false;
    let next = firstAt(group.askTimes, request.timestamp, true);
    // The request never counts as asking again, even when the list holds an event with its id at a later time.
    while (next < group.askIds.length && group.askIds[next] === request.id) next++;
    const askedAgain = group.askTimes[next] ?? Infinity;
    const completed = group.completions[firstAt(group.completions, request.timestamp, false)];
    return completed !== undefined && completed < askedAgain;
  };
}

/** Recent requests come from the snapshot's approvals; earlier ones are only those still among its newest events. */
export function approvalRequests(
  snapshot: Pick<DashboardSnapshot, "events" | "approvals">,
  now = Date.now(),
): { recent: DashboardEvent[]; earlier: DashboardEvent[]; waiting: DashboardEvent[]; open: number } {
  const { windowMs, events } = snapshot.approvals;
  const recent = recentApprovalRequests(snapshot.approvals, now);
  const earlier = snapshot.events
    .filter((event) => eventStatus(event) === "Needs approval" && now - event.timestamp > windowMs)
    .sort((a, b) => b.timestamp - a.timestamp);
  const ran = ranAfterwardsIndex(events);
  const waiting = recent.filter((event) => !ran(event));
  return { recent, earlier, waiting, open: waiting.length };
}

/** When the next recent approval request leaves the window (D-6), or null when none is in it. */
export function nextApprovalExpiry(approvals: ApprovalWindow, now: number): number | null {
  let next: number | null = null;
  for (const event of approvals.events) {
    // recentApprovalRequests keeps a request while now - timestamp <= windowMs, so it leaves 1 ms after that.
    const leaves = event.timestamp + approvals.windowMs + 1;
    if (leaves > now && eventStatus(event) === "Needs approval" && (next === null || leaves < next)) next = leaves;
  }
  return next;
}

/** Each session's count of requests with no record they ran, and its verdict strip, from one pass over the events. */
export function sessionSummaries(events: DashboardEvent[]): Map<string, { waiting: number; marks: StripMark[] }> {
  const timelines = new Map<string, DashboardEvent[]>();
  for (const event of events) {
    if (!event.toolName) continue;
    const timeline = timelines.get(event.sessionId);
    if (timeline) timeline.push(event);
    else timelines.set(event.sessionId, [event]);
  }
  const ran = ranAfterwardsIndex(events);
  const summaries = new Map<string, { waiting: number; marks: StripMark[] }>();
  for (const [id, timeline] of timelines) {
    timeline.sort((a, b) => b.timestamp - a.timestamp);
    const waiting = timeline.filter((event) => eventStatus(event) === "Needs approval" && !ran(event)).length;
    summaries.set(id, { waiting, marks: verdictStrip(timeline) });
  }
  return summaries;
}

export function sessionTimeline(events: DashboardEvent[], sessionId: string): DashboardEvent[] {
  return events
    .filter((event) => event.sessionId === sessionId && event.toolName)
    .sort((a, b) => b.timestamp - a.timestamp);
}

const EVENT_CHIPS: Record<string, string> = {
  SessionStart: "Session started",
  UserPromptSubmit: "Prompt",
  Stop: "Stopped",
  PreCompact: "Compacted",
  SessionEnd: "Session ended",
};

/** Tool calls show their verdict; every other hook gets a neutral chip with what happened. */
export function timelineChip(event: DashboardEvent): { label: string; tone: "status" | "event" } {
  if (event.hookEventName === "PreToolUse" || event.hookEventName === "PostToolUse")
    return { label: eventStatus(event), tone: "status" };
  return { label: EVENT_CHIPS[event.hookEventName] ?? event.hookEventName, tone: "event" };
}

export function blobNote(event: PublicEvent): string | null {
  if (!event.outputStoredSeparately) return null;
  return `Output stored separately (${Math.ceil(event.outputStoredSeparately.originalSize / 1024)} KB)`;
}

export type StripMark = "allowed" | "guidance" | "approval" | "blocked" | "observed";

const MARKS: Record<string, StripMark> = {
  Allowed: "allowed",
  Guidance: "guidance",
  "Needs approval": "approval",
  Blocked: "blocked",
  Observed: "observed",
};

/** One mark per tool call a rule judged, oldest first, keeping the newest max so a long session stays one line. */
export function verdictStrip(timeline: DashboardEvent[], max = 60): StripMark[] {
  return timeline
    .filter((event) => event.hookEventName === "PreToolUse")
    .slice(0, max)
    .reverse()
    .map((event) => MARKS[eventStatus(event)] ?? "allowed");
}

export function formatUptime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours} h ${minutes} min`;
  return minutes ? `${minutes} min` : "under a minute";
}
