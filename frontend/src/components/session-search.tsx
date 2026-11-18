"use client";

import { type FormEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { type DashboardEvent, type PublicEvent, agentLabel } from "@/lib/events";
import {
  EMPTY_SEARCH,
  SEARCH_AGENTS,
  SEARCH_VERDICTS,
  type SearchState,
  appendPage,
  isEmptySearch,
  isStale,
  newestRowId,
  parseSearchHash,
  searchError,
  searchHash,
  searchUrl,
} from "@/lib/search";
import { Timeline } from "./timeline";

type Results =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "done"; events: PublicEvent[]; next: number | null; loadingMore: boolean };

/** Reads a JSON answer; a failed one gives the server's error text, or a fixed one when there is none. */
export async function fetchJson<T>(url: string): Promise<{ ok: true; body: T } | { ok: false; message: string }> {
  try {
    const response = await fetch(url, { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as (T & { error?: unknown }) | null;
    if (response.ok && body) return { ok: true, body };
    const message = typeof body?.error === "string" ? body.error : `The backend answered ${response.status}.`;
    return { ok: false, message };
  } catch {
    return { ok: false, message: "The backend could not be reached." };
  }
}

/**
 * "Search all events" on the Sessions page. The search lives in the address hash (`#sessions?q=…`), so a reload
 * or a copied link opens the same results. Live events do not re-run it; a note offers a refresh instead.
 */
export function SessionSearch({
  apiOrigin,
  projectId,
  liveEvents,
  onOpen,
}: {
  apiOrigin: string;
  projectId: string | null;
  liveEvents: DashboardEvent[];
  onOpen: (event: PublicEvent) => void;
}) {
  const [applied, setApplied] = useState<SearchState | null>(null);
  const [draft, setDraft] = useState<SearchState>(EMPTY_SEARCH);
  const [formError, setFormError] = useState<string | null>(null);
  const [results, setResults] = useState<Results>({ state: "idle" });
  const [seenNewest, setSeenNewest] = useState<number | null>(null);
  const live = useRef(liveEvents);
  live.current = liveEvents;
  const run = useRef(0);

  useEffect(() => {
    const sync = () => {
      const fromHash = parseSearchHash(window.location.hash);
      setApplied(fromHash);
      setDraft(fromHash ?? EMPTY_SEARCH);
      setFormError(null);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  const search = useCallback(
    async (state: SearchState) => {
      const id = ++run.current;
      setResults({ state: "loading" });
      setSeenNewest(newestRowId(live.current));
      const answer = await fetchJson<{ events: PublicEvent[]; nextBefore: number | null }>(
        apiOrigin + searchUrl(projectId, state),
      );
      if (id !== run.current) return;
      setResults(
        answer.ok
          ? { state: "done", events: answer.body.events, next: answer.body.nextBefore, loadingMore: false }
          : { state: "failed", message: answer.message },
      );
    },
    [apiOrigin, projectId],
  );

  useEffect(() => {
    if (applied) void search(applied);
    else setResults({ state: "idle" });
  }, [applied, search]);

  async function loadMore() {
    if (!applied || results.state !== "done" || results.next === null) return;
    const id = run.current;
    setResults({ ...results, loadingMore: true });
    const answer = await fetchJson<{ events: PublicEvent[]; nextBefore: number | null }>(
      apiOrigin + searchUrl(projectId, applied, results.next),
    );
    if (id !== run.current) return;
    if (!answer.ok) {
      setResults({ state: "failed", message: answer.message });
      return;
    }
    const page = appendPage(results.events, { events: answer.body.events, next: answer.body.nextBefore });
    setResults({ state: "done", events: page.events, next: answer.body.nextBefore, loadingMore: false });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const error = searchError(draft);
    setFormError(error);
    if (error) return;
    const hash = isEmptySearch(draft) ? "#sessions" : searchHash(draft);
    // The same hash fires no hashchange, so a repeated search runs here.
    if (hash === window.location.hash) {
      if (applied) void search(applied);
    } else window.location.hash = hash;
  }

  const set = (field: keyof SearchState) => (event: { target: { value: string } }) =>
    setDraft((current) => ({ ...current, [field]: event.target.value }));
  const tools = [...new Set([...liveEvents.map((event) => event.toolName ?? ""), draft.tool])].filter(Boolean).sort();
  const stale = results.state === "done" && isStale(seenNewest, liveEvents);

  return (
    <div className="pg-box pg-search">
      <form className="pg-search-form" role="search" onSubmit={submit} noValidate>
        <div className="pg-search-q">
          <label htmlFor="pg-search-q">Search all events</label>
          <div className="pg-search-row">
            <input
              id="pg-search-q"
              className="st-input"
              type="search"
              value={draft.q}
              placeholder="Commands, files, outputs, rules"
              maxLength={200}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={formError === "Type at least 2 characters." ? "true" : undefined}
              aria-describedby={formError ? "pg-search-error" : undefined}
              onChange={set("q")}
            />
            <button type="submit" className="ov-btn">
              Search
            </button>
          </div>
        </div>
        <div className="pg-filters">
          <Filter id="pg-search-agent" label="Agent" value={draft.agent} onChange={set("agent")}>
            {SEARCH_AGENTS.map((agent) => (
              <option key={agent} value={agent}>
                {agentLabel(agent)}
              </option>
            ))}
          </Filter>
          <Filter id="pg-search-verdict" label="Verdict" value={draft.verdict} onChange={set("verdict")}>
            {SEARCH_VERDICTS.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </Filter>
          <Filter id="pg-search-tool" label="Tool" value={draft.tool} onChange={set("tool")}>
            {tools.map((tool) => (
              <option key={tool} value={tool}>
                {tool}
              </option>
            ))}
          </Filter>
          <div className="pg-filter">
            <label htmlFor="pg-search-from">From</label>
            <input id="pg-search-from" className="st-input" type="date" value={draft.from} onChange={set("from")} />
          </div>
          <div className="pg-filter">
            <label htmlFor="pg-search-to">To</label>
            <input id="pg-search-to" className="st-input" type="date" value={draft.to} onChange={set("to")} />
          </div>
        </div>
        {formError && (
          <p id="pg-search-error" className="pg-err" role="alert">
            {formError}
          </p>
        )}
      </form>
      {results.state !== "idle" && (
        <div className="pg-results">
          <div className="pg-results-head">
            <h2>Search results</h2>
            <span>newest first</span>
          </div>
          <div aria-live="polite">
            {stale && applied && (
              <p className="pg-note pg-note-box pg-live">
                <span>New events since this search.</span>
                <button type="button" className="ov-btn ov-btn-sm" onClick={() => void search(applied)}>
                  Refresh
                </button>
              </p>
            )}
            {results.state === "loading" && <p className="pg-empty">Searching…</p>}
            {results.state === "failed" && <p className="pg-empty pg-err">Search failed: {results.message}</p>}
          </div>
          {results.state === "done" && (
            <>
              <Timeline
                events={results.events}
                showAgent
                showDate
                label="Search results"
                emptyText="No events match this search."
                onPick={(event) => onOpen(event as PublicEvent)}
              />
              {results.next !== null && (
                <div className="pg-more">
                  <button
                    type="button"
                    className="ov-btn"
                    disabled={results.loadingMore}
                    onClick={() => void loadMore()}
                  >
                    Load more
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function Filter({
  id,
  label,
  value,
  onChange,
  children,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (event: { target: { value: string } }) => void;
  children: ReactNode;
}) {
  return (
    <div className="pg-filter">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="st-select" value={value} onChange={onChange}>
        <option value="">Any</option>
        {children}
      </select>
    </div>
  );
}
