// Search and timeline state for the Sessions page. No React, so the Node test runner can load it directly.
import { type DashboardEvent, type PublicEvent } from "./events.ts";

/** What the search form holds. An empty string means "Any"; dates are YYYY-MM-DD in the browser's time zone. */
export type SearchState = { q: string; agent: string; verdict: string; tool: string; from: string; to: string };

export const EMPTY_SEARCH: SearchState = { q: "", agent: "", verdict: "", tool: "", from: "", to: "" };

/** The agent names the CLI records, in the order the filter lists them. */
export const SEARCH_AGENTS = ["claude-code", "codex", "opencode", "cursor", "gemini", "custom"];

/** Verdict values with the labels the dashboard already uses for them. */
export const SEARCH_VERDICTS: [string, string][] = [
  ["ALLOW", "Allowed"],
  ["DENY", "Blocked"],
  ["REQUIRE_MANUAL_APPROVAL", "Needs approval"],
  ["INSTRUCT", "Guidance"],
];

const FIELDS = ["q", "agent", "verdict", "tool", "from", "to"] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The search in `#sessions?…`, or null when the hash holds none. Values the server would refuse are dropped. */
export function parseSearchHash(hash: string): SearchState | null {
  const text = hash.replace(/^#/, "");
  const mark = text.indexOf("?");
  const page = mark === -1 ? text : text.slice(0, mark);
  const query = mark === -1 ? "" : text.slice(mark + 1);
  if (page !== "sessions" || !query) return null;
  const params = new URLSearchParams(query);
  const read = (name: string) => params.get(name) ?? "";
  const state: SearchState = {
    q: read("q"),
    agent: SEARCH_AGENTS.includes(read("agent")) ? read("agent") : "",
    verdict: SEARCH_VERDICTS.some(([value]) => value === read("verdict")) ? read("verdict") : "",
    tool: read("tool"),
    from: DATE.test(read("from")) ? read("from") : "",
    to: DATE.test(read("to")) ? read("to") : "",
  };
  return isEmptySearch(state) ? null : state;
}

export function searchHash(state: SearchState): string {
  const params = new URLSearchParams();
  for (const field of FIELDS) if (state[field]) params.set(field, state[field]);
  const query = params.toString();
  return query ? `#sessions?${query}` : "#sessions";
}

export function isEmptySearch(state: SearchState): boolean {
  return FIELDS.every((field) => !state[field].trim());
}

/** The checks the browser can make itself, with the page's wording; the server checks everything again. */
export function searchError(state: SearchState): string | null {
  const q = state.q.trim();
  if (q.length === 1) return "Type at least 2 characters.";
  if (state.from && state.to && state.from > state.to) return "From must be before To.";
  return null;
}

function localMidnight(date: string, addDays = 0): number {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day + addDays).getTime();
}

function apiUrl(path: string, projectId: string | null, params: URLSearchParams): string {
  if (projectId) params.set("project", projectId);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** `To` is inclusive for the user, so the request ends at the next day's midnight. */
export function searchUrl(projectId: string | null, state: SearchState, before?: number): string {
  const params = new URLSearchParams();
  const q = state.q.trim();
  if (q) params.set("q", q);
  if (state.agent) params.set("agent", state.agent);
  if (state.verdict) params.set("verdict", state.verdict);
  if (state.tool) params.set("tool", state.tool);
  if (state.from) params.set("from", String(localMidnight(state.from)));
  if (state.to) params.set("to", String(localMidnight(state.to, 1)));
  if (before !== undefined) params.set("before", String(before));
  return apiUrl("/api/events/search", projectId, params);
}

/** Where a timeline page starts: after a sequence number, or after an exact row when numbers repeat. */
export type TimelineCursor = { after: number } | { sequenceNum: number; rowId: number };

export function timelineUrl(projectId: string | null, sessionId: string, cursor?: TimelineCursor): string {
  const params = new URLSearchParams();
  if (cursor && "after" in cursor) params.set("after", String(cursor.after));
  if (cursor && "rowId" in cursor) {
    params.set("after", String(cursor.sequenceNum));
    params.set("afterRow", String(cursor.rowId));
  }
  return apiUrl(`/api/sessions/${encodeURIComponent(sessionId)}/timeline`, projectId, params);
}

/** A search result opens its session's timeline at that event. */
export function timelineStart(event: PublicEvent): TimelineCursor {
  return { after: Math.max(0, event.sequenceNum - 1) };
}

export type TimelinePage = { events: PublicEvent[]; nextAfter: { sequenceNum: number; rowId: number } | null };

export function nextTimelineCursor(page: TimelinePage): TimelineCursor | null {
  return page.nextAfter;
}

/** Adds a page to what is shown; a row already shown is not added twice. */
export function appendPage(
  shown: PublicEvent[],
  page: { events: PublicEvent[]; next: unknown },
): { events: PublicEvent[]; hasMore: boolean } {
  const seen = new Set(shown.map((event) => event.id));
  return {
    events: [...shown, ...page.events.filter((event) => !seen.has(event.id))],
    hasMore: page.next !== null && page.next !== undefined,
  };
}

export function newestRowId(events: DashboardEvent[]): number {
  return events.reduce((newest, event) => Math.max(newest, event.rowId ?? 0), 0);
}

/** Live events do not re-run a search; the page says so once the log has a row newer than the search saw. */
export function isStale(seenNewest: number | null, snapshotEvents: DashboardEvent[]): boolean {
  return seenNewest !== null && newestRowId(snapshotEvents) > seenNewest;
}
