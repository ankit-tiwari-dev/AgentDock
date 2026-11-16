"use client";

import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  type DashboardEvent,
  type DashboardSession,
  type DashboardSnapshot,
  type StreamFilter,
  agentLabel,
  eventStatus,
  eventTarget,
  filterStream,
  newlyArrived,
  projectName,
  approvalRequests,
  recentApprovalRequests,
  relativeTime,
  statusTone,
  streamCounts,
  unseenEvents,
} from "@/lib/events";

export const SETUP_COMMAND = "ctrlplane init --agent all";
const STREAM_ROWS = 50;
const NEEDS_SHOWN = 3;

type Props = {
  snapshot: DashboardSnapshot;
  connected: boolean;
  backendReachable: boolean;
  checked: boolean;
  onCopy: (text: string, label: string) => void;
};

export default function Overview({ snapshot, connected, backendReachable, checked, onCopy }: Props) {
  const [filter, setFilter] = useState<StreamFilter>("all");
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [frozen, setFrozen] = useState<DashboardEvent[] | null>(null);
  const [selected, setSelected] = useState<DashboardEvent | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [fresh, setFresh] = useState<Set<string>>(() => new Set());
  const seen = useRef<Set<string> | null>(null);
  const freshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const searchRef = useRef<HTMLInputElement>(null);
  const needsRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const paused = frozen !== null;
  const shown = frozen ?? snapshot.events;
  const queued = paused ? unseenEvents(snapshot.events, frozen) : [];

  useEffect(() => {
    const added = newlyArrived(seen.current, shown);
    seen.current = new Set(shown.map((event) => event.id));
    if (!added.length) return;
    setFresh(new Set(added));
    // One tool call triggers several refreshes; a refresh that adds nothing must not cancel the pending clear.
    clearTimeout(freshTimer.current);
    freshTimer.current = setTimeout(() => setFresh(new Set()), 1600);
  }, [shown]);

  useEffect(() => () => clearTimeout(freshTimer.current), []);

  const counts = useMemo(() => streamCounts(shown), [shown]);
  const visible = useMemo(() => filterStream(shown, filter, query), [shown, filter, query]);
  const asked = recentApprovalRequests(snapshot.events, now);
  const waiting = approvalRequests(snapshot.events, now).waiting;
  const activeSessions = snapshot.sessions.filter((session) => session.status === "active");
  const latest = snapshot.events[0];
  const empty = checked && backendReachable && snapshot.events.length === 0;

  let liveState = "Connecting";
  let lastEvent = "";
  let liveTone = "ov-live-off";
  if (checked && !backendReachable) {
    liveState = "Offline · reconnecting";
    liveTone = "ov-live-down";
  } else if (connected) {
    liveState = paused ? "Paused" : "Live";
    lastEvent = latest ? ` · last event ${relativeTime(latest.timestamp, now).toLowerCase()}` : "";
    liveTone = paused ? "ov-live-off" : "";
  }

  return (
    <>
      <div className="ov-head">
        <div className="ov-head-text">
          <h1>Agent activity</h1>
          <p>
            Every tool call your agents make
            {snapshot.source?.projectPath ? (
              <>
                {" "}
                in <code>{projectName(snapshot.source.projectPath)}</code>
              </>
            ) : null}
            , judged by your rules as it happens.
          </p>
        </div>
        <div className="ov-head-actions">
          <span className={`ov-live ${liveTone}`}>
            <span className="ov-dot" aria-hidden="true" />
            {/* Only the state is announced; the ticking "last event" time would be read out every second. */}
            <span role="status">{liveState}</span>
            {lastEvent}
          </span>
          <button
            type="button"
            className="ov-btn"
            disabled={!paused && !backendReachable}
            onClick={() => setFrozen(paused ? null : snapshot.events)}
          >
            {paused ? <PlayIcon /> : <PauseIcon />}
            {paused ? "Resume stream" : "Pause stream"}
          </button>
        </div>
      </div>

      <section className="ov-metrics" aria-label="Totals">
        <div className="ov-card">
          <span className="ov-k">Tool calls</span>
          <span className="ov-v">{snapshot.counts.toolCalls.toLocaleString()}</span>
          <span className="ov-k">{snapshot.counts.totalEvents.toLocaleString()} events stored locally</span>
        </div>
        <button
          type="button"
          className="ov-card ov-card-button"
          aria-label={`Blocked: ${snapshot.counts.blockedCalls}. Show blocked calls`}
          onClick={() => {
            setFilter("Blocked");
            searchRef.current?.focus();
          }}
        >
          <span className="ov-k">Blocked</span>
          <span className="ov-v ov-v-blocked">{snapshot.counts.blockedCalls.toLocaleString()}</span>
          <span className="ov-k">stopped by your rules</span>
        </button>
        <button
          type="button"
          className="ov-card ov-card-button ov-card-warn"
          aria-label={`Asked for approval: ${snapshot.counts.reviewCalls}. Show approval requests`}
          onClick={() => {
            setFilter("Needs approval");
            needsRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
          }}
        >
          <span className="ov-k">Asked for approval</span>
          <span className="ov-v ov-v-ask">{snapshot.counts.reviewCalls.toLocaleString()}</span>
          <span className="ov-k">{asked.length} in the last 15 minutes</span>
        </button>
        <div className="ov-card">
          <span className="ov-k">Active sessions</span>
          <span className="ov-v">{snapshot.counts.activeSessions.toLocaleString()}</span>
          <span className="ov-k">
            {activeSessions.length
              ? [...new Set(activeSessions.map((session) => agentLabel(session.agent)))].join(", ")
              : "No agent running"}
          </span>
        </div>
      </section>

      <div className="ov-columns">
        <section className="ov-panel ov-stream" aria-labelledby="ov-stream-title">
          <div className="ov-panel-head">
            <h2 id="ov-stream-title">Live stream</h2>
            <div className="ov-pills" role="group" aria-label="Filter by verdict">
              <FilterPill label="All" count={counts.all} active={filter === "all"} onClick={() => setFilter("all")} />
              <FilterPill
                label="Blocked"
                count={counts.blocked}
                active={filter === "Blocked"}
                onClick={() => setFilter("Blocked")}
              />
              <FilterPill
                label="Needs approval"
                count={counts.approval}
                active={filter === "Needs approval"}
                onClick={() => setFilter("Needs approval")}
              />
            </div>
            <label className="ov-search">
              <SearchIcon />
              <span className="ov-sr">Search commands, files and rules</span>
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search commands, files, rules"
              />
            </label>
          </div>

          <div aria-live="polite">
            {queued.length > 0 && (
              <div className="ov-queued">
                <button type="button" onClick={() => setFrozen(snapshot.events)}>
                  {queued.length} new event{queued.length === 1 ? "" : "s"}. Show them
                </button>
              </div>
            )}
          </div>

          {empty ? (
            <div className="ov-empty">
              <h3>No agent activity yet</h3>
              <p>Set up the hooks in your project, then start an agent. Each tool call it makes shows up here.</p>
              <span className="ov-codeline">
                <code>{SETUP_COMMAND}</code>
                <button
                  type="button"
                  className="ov-btn ov-btn-sm"
                  onClick={() => onCopy(SETUP_COMMAND, "Setup command")}
                >
                  Copy
                </button>
              </span>
            </div>
          ) : visible.length === 0 && shown.length > 0 ? (
            <div className="ov-empty">
              <h3>Nothing matches</h3>
              <p>No events match this filter{query.trim() ? " and search" : ""}.</p>
              <button
                type="button"
                className="ov-btn ov-btn-sm"
                onClick={() => {
                  setQuery("");
                  setFilter("all");
                }}
              >
                Clear filters
              </button>
            </div>
          ) : (
            <div className="ov-table" role="region" aria-label="Events" tabIndex={0}>
              <div className="ov-row ov-row-head" aria-hidden="true">
                <span>Time</span>
                <span>Agent</span>
                <span>Action</span>
                <span>Verdict</span>
                <span>Rule</span>
              </div>
              <ul>
                {(showAll ? visible : visible.slice(0, STREAM_ROWS)).map((event) => (
                  <li key={event.id}>
                    <StreamRow event={event} fresh={fresh.has(event.id)} onOpen={() => setSelected(event)} />
                  </li>
                ))}
              </ul>
            </div>
          )}

          {visible.length > STREAM_ROWS && (
            <div className="ov-stream-foot">
              {showAll ? `Showing all ${visible.length}.` : `Showing the newest ${STREAM_ROWS} of ${visible.length}.`}{" "}
              <button type="button" className="ov-link" onClick={() => setShowAll(!showAll)}>
                {showAll ? `Show the newest ${STREAM_ROWS}` : `Show all ${visible.length}`}
              </button>
            </div>
          )}
        </section>

        <div className="ov-rail">
          <section ref={needsRef} className="ov-panel ov-needs" aria-labelledby="ov-needs-title">
            <h2 id="ov-needs-title">Needs you</h2>
            {waiting.length ? (
              <>
                {waiting.slice(0, NEEDS_SHOWN).map((event) => (
                  <ApprovalItem key={event.id} event={event} />
                ))}
                {waiting.length > NEEDS_SHOWN && (
                  <a className="ov-btn ov-btn-sm" href="#waiting">
                    {waiting.length - NEEDS_SHOWN} more waiting. See them all
                  </a>
                )}
              </>
            ) : (
              <p className="ov-needs-text">
                Nothing is waiting for you. When an agent asks before a risky change, it shows up here with what it
                wants and why.
              </p>
            )}
          </section>

          <section className="ov-panel" aria-labelledby="ov-sessions-title">
            <h2 id="ov-sessions-title">Sessions</h2>
            {snapshot.sessions.length ? (
              snapshot.sessions
                .slice(0, 5)
                .map((session) => <SessionLine key={session.id} session={session} now={now} />)
            ) : (
              <p className="ov-muted">No sessions recorded yet.</p>
            )}
          </section>
        </div>
      </div>

      <EventDetail
        event={selected}
        onClose={() => setSelected(null)}
        fallbackFocus={() => searchRef.current?.focus()}
      />
    </>
  );
}

function FilterPill({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className="ov-pill" aria-pressed={active} onClick={onClick}>
      {label} <span className="ov-pill-n">{count}</span>
    </button>
  );
}

function StreamRow({ event, fresh, onOpen }: { event: DashboardEvent; fresh: boolean; onOpen: () => void }) {
  const status = eventStatus(event);
  const action = event.toolName || event.hookEventName;
  const target = eventTarget(event);
  const rule = ruleName(event);
  return (
    <button
      type="button"
      className={`ov-row ${fresh ? "ov-fresh" : ""}`}
      onClick={onOpen}
      aria-label={`${agentLabel(event.agent)} ${action} ${target}, ${status}${rule ? `, rule ${rule}` : ""}. Open details`}
    >
      <span className="ov-mono ov-muted">{clock(event.timestamp)}</span>
      <span>{agentLabel(event.agent)}</span>
      <span className="ov-action">
        <span className="ov-muted">{action}</span> <span className="ov-mono ov-target">{target}</span>
      </span>
      <span>
        <StatusChip status={status} />
      </span>
      <span className="ov-mono ov-rule">{rule || "-"}</span>
    </button>
  );
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`ov-chip ov-chip-${statusTone(status)}`}>
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

function ApprovalItem({ event }: { event: DashboardEvent }) {
  const agent = agentLabel(event.agent);
  const rule = ruleName(event);
  return (
    <div className="ov-need">
      <span className="ov-need-meta">
        {agent} · {clock(event.timestamp)}
        {rule ? ` · rule ${rule}` : ""}
      </span>
      <code className="ov-need-target">{eventTarget(event) || event.toolName}</code>
      {event.reason && <p className="ov-needs-text">{event.reason}</p>}
      <p className="ov-needs-text">Answer it in {agent}.</p>
    </div>
  );
}

function SessionLine({ session, now }: { session: DashboardSession; now: number }) {
  const state =
    session.status === "active"
      ? "Active"
      : session.status === "idle"
        ? `Idle · ${relativeTime(session.lastActivity, now).toLowerCase()}`
        : `Ended · ${relativeTime(session.lastActivity, now).toLowerCase()}`;
  return (
    <div className="ov-session">
      <span className="ov-session-name">{agentLabel(session.agent)}</span>
      <span className="ov-mono ov-muted">
        {session.toolCalls} calls{session.blockedCalls ? ` · ${session.blockedCalls} blocked` : ""}
      </span>
      <span className={`ov-session-state ${session.status === "active" ? "ov-session-active" : ""}`}>{state}</span>
    </div>
  );
}

export function EventDetail({
  event,
  onClose,
  fallbackFocus,
}: {
  event: DashboardEvent | null;
  onClose: () => void;
  fallbackFocus: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (event && !element.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      element.showModal();
    }
  }, [event]);

  function handleClose() {
    onClose();
    // New events can push the opened row out of the list while the panel is open.
    if (opener.current?.isConnected) opener.current.focus();
    else fallbackFocus();
  }

  const status = event ? eventStatus(event) : "";
  const rule = event ? ruleName(event) : "";
  return (
    <dialog
      ref={dialog}
      className="ov-drawer"
      aria-labelledby="ov-drawer-title"
      onClose={handleClose}
      onClick={(click) => {
        if (click.target === dialog.current) dialog.current?.close();
      }}
    >
      {event && (
        <>
          <div className="ov-drawer-head">
            <h2 id="ov-drawer-title">
              {event.toolName || event.hookEventName} · {status}
            </h2>
            <button
              type="button"
              className="ov-icon-btn"
              aria-label="Close details"
              onClick={() => dialog.current?.close()}
            >
              <CloseIcon />
            </button>
          </div>
          <div className="ov-drawer-body">
            <div className={`ov-why ov-why-${statusTone(status)}`}>
              {event.reason ||
                (rule ? `Matched rule ${rule}.` : "No rule matched, so the call went ahead and was recorded.")}
            </div>
            <dl className="ov-kv">
              <dt>Time</dt>
              <dd className="ov-mono">{new Date(event.timestamp).toLocaleString()}</dd>
              <dt>Agent</dt>
              <dd>{agentLabel(event.agent)}</dd>
              <dt>Session</dt>
              <dd className="ov-mono">{event.sessionId}</dd>
              <dt>Hook</dt>
              <dd>{event.hookEventName}</dd>
              <dt>Verdict</dt>
              <dd>
                <StatusChip status={status} />
              </dd>
              <dt>Rule</dt>
              <dd className="ov-mono">{rule || "none"}</dd>
              <dt>Took</dt>
              <dd className="ov-mono">{event.latencyMs === undefined ? "not recorded" : formatMs(event.latencyMs)}</dd>
            </dl>
            <Payload label="Tool input" value={event.toolInput} />
            <Payload label="Tool output" value={event.toolOutput} />
          </div>
        </>
      )}
    </dialog>
  );
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  return (
    <div>
      <div className="ov-payload-label">{label}</div>
      <pre className="ov-pre">{typeof value === "string" ? value : JSON.stringify(value, null, 2)}</pre>
    </div>
  );
}

function ruleName(event: DashboardEvent): string {
  return event.ruleId ?? "";
}

export function clock(time: number): string {
  return new Date(time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function Svg({ children, size = 12 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

function StatusIcon({ status }: { status: string }) {
  if (status === "Blocked" || status === "Failed")
    return (
      <Svg>
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </Svg>
    );
  if (status === "Needs approval")
    return (
      <Svg>
        <rect x="6" y="4" width="4" height="16" />
        <rect x="14" y="4" width="4" height="16" />
      </Svg>
    );
  if (status === "Guidance")
    return (
      <Svg>
        <polyline points="9 18 15 12 9 6" />
      </Svg>
    );
  if (status === "Observed")
    return (
      <Svg>
        <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" />
        <circle cx="12" cy="12" r="3" />
      </Svg>
    );
  return (
    <Svg>
      <polyline points="20 6 9 17 4 12" />
    </Svg>
  );
}

function PauseIcon() {
  return (
    <Svg size={14}>
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </Svg>
  );
}

function PlayIcon() {
  return (
    <Svg size={14}>
      <polygon points="6 4 20 12 6 20 6 4" />
    </Svg>
  );
}

function SearchIcon() {
  return (
    <Svg size={14}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.6" y2="16.6" />
    </Svg>
  );
}

function CloseIcon() {
  return (
    <Svg size={16}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </Svg>
  );
}

export function WarnIcon() {
  return (
    <Svg size={18}>
      <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </Svg>
  );
}
