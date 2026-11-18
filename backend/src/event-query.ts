/**
 * Query rules for event search and the session timeline. Every value is checked before any SQL runs, and an error
 * message is fixed text: it never repeats what the client sent, because a user may paste a secret into the search box.
 */

/** The agent names agentdock-cli writes to `sessions.agent_type`. */
export const AGENT_TYPES = ["claude-code", "codex", "opencode", "cursor", "gemini", "custom"] as const;
export const VERDICTS = ["ALLOW", "DENY", "INSTRUCT", "REQUIRE_MANUAL_APPROVAL"] as const;
export const QUERY_LIMITS = {
  qMin: 2,
  qMax: 200,
  toolMax: 200,
  searchDefault: 50,
  timelineDefault: 200,
  max: 200,
} as const;

export const QUERY_ERRORS = {
  q: "Search text must be 2 to 200 characters.",
  agent: "Unknown agent.",
  verdict: "Unknown verdict.",
  tool: "Tool name must be 1 to 200 characters.",
  time: "from and to must be times in milliseconds since 1970, with from before to.",
  before: "before must be a whole number of 1 or more.",
  after: "after must be a whole number of 0 or more.",
  afterRow: "afterRow must be a whole number of 1 or more, given together with after.",
  limit: "limit must be a whole number from 1 to 200.",
} as const;

export interface SearchQuery {
  q: string | null;
  agent: string | null;
  verdict: string | null;
  tool: string | null;
  from: number | null;
  to: number | null;
  before: number | null;
  limit: number;
}

export interface TimelineQuery {
  /** Start after this sequence number. */
  after: number | null;
  /** With `after`: also take later rows that share that sequence number, after this rowid. */
  afterRow: number | null;
  limit: number;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

class Invalid extends Error {}

/** `^\d+$` only, so `1e3`, `-1` and `1.5` fail. */
function wholeNumber(params: URLSearchParams, name: string, min: number, error: string): number | null {
  const raw = params.get(name);
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) throw new Invalid(error);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min) throw new Invalid(error);
  return value;
}

function limitOf(params: URLSearchParams, fallback: number): number {
  const value = wholeNumber(params, "limit", 1, QUERY_ERRORS.limit);
  if (value === null) return fallback;
  if (value > QUERY_LIMITS.max) throw new Invalid(QUERY_ERRORS.limit);
  return value;
}

function oneOf(params: URLSearchParams, name: string, allowed: readonly string[], error: string): string | null {
  const raw = params.get(name);
  if (raw === null) return null;
  if (!allowed.includes(raw)) throw new Invalid(error);
  return raw;
}

function parse<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (err) {
    if (err instanceof Invalid) return { ok: false, error: err.message };
    throw err;
  }
}

export function parseSearchQuery(params: URLSearchParams): Parsed<SearchQuery> {
  return parse(() => {
    const trimmed = params.get("q")?.trim() ?? "";
    if (trimmed !== "" && (trimmed.length < QUERY_LIMITS.qMin || trimmed.length > QUERY_LIMITS.qMax)) {
      throw new Invalid(QUERY_ERRORS.q);
    }
    const tool = params.get("tool");
    if (tool !== null && (tool.length < 1 || tool.length > QUERY_LIMITS.toolMax)) throw new Invalid(QUERY_ERRORS.tool);
    const from = wholeNumber(params, "from", 0, QUERY_ERRORS.time);
    const to = wholeNumber(params, "to", 0, QUERY_ERRORS.time);
    if (from !== null && to !== null && from >= to) throw new Invalid(QUERY_ERRORS.time);
    return {
      q: trimmed === "" ? null : trimmed,
      agent: oneOf(params, "agent", AGENT_TYPES, QUERY_ERRORS.agent),
      verdict: oneOf(params, "verdict", VERDICTS, QUERY_ERRORS.verdict),
      tool,
      from,
      to,
      before: wholeNumber(params, "before", 1, QUERY_ERRORS.before),
      limit: limitOf(params, QUERY_LIMITS.searchDefault),
    };
  });
}

export function parseTimelineQuery(params: URLSearchParams): Parsed<TimelineQuery> {
  return parse(() => {
    const after = wholeNumber(params, "after", 0, QUERY_ERRORS.after);
    const afterRow = wholeNumber(params, "afterRow", 1, QUERY_ERRORS.afterRow);
    if (afterRow !== null && after === null) throw new Invalid(QUERY_ERRORS.afterRow);
    return { after, afterRow, limit: limitOf(params, QUERY_LIMITS.timelineDefault) };
  });
}

/** A LIKE pattern that matches `text` literally anywhere; use with `ESCAPE '\'`. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * How `text` looks inside the stored JSON: the CLI stores inputs and outputs as JSON, so a typed `C:\Users` is
 * stored as `C:\\Users` and a quote as `\"`.
 */
export function jsonEscapedText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}
