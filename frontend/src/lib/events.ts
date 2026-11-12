// Pure helpers for the dashboard. No React and no imports, so the Node test runner can load this file directly.

export type DashboardEvent = {
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
};

export type DashboardSnapshot = {
  source?: { projectPath: string; databasePath: string; available: boolean };
  events: DashboardEvent[];
  sessions: DashboardSession[];
  counts: { toolCalls: number; blockedCalls: number; reviewCalls: number; activeSessions: number; totalEvents: number };
};

export type RuleSummary = { id: string; count: number; latestDecision: string; latestReason: string; timestamp: number };

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
    const current = rules.get(key);
    if (!current) {
      rules.set(key, {
        id: key,
        count: 1,
        latestDecision: eventStatus(event),
        latestReason: event.reason || "",
        timestamp: event.timestamp,
      });
    } else {
      current.count++;
      if (event.timestamp > current.timestamp)
        Object.assign(current, {
          latestDecision: eventStatus(event),
          latestReason: event.reason || "",
          timestamp: event.timestamp,
        });
    }
  }
  return [...rules.values()].sort((a, b) => b.timestamp - a.timestamp);
}

export function statusTone(status: string): string {
  if (status === "Blocked" || status === "DENY" || status === "Failed") return "blocked";
  if (status === "Needs approval" || status === "REQUIRE_MANUAL_APPROVAL" || status === "Observed") return "review";
  if (status === "Guidance" || status === "INSTRUCT") return "guidance";
  return "allowed";
}
