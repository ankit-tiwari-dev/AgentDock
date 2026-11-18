"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  type DashboardEvent,
  type DashboardSession,
  type DashboardSnapshot,
  type PublicEvent,
  agentLabel,
  eventStatus,
  ranAfterwards,
  relativeTime,
  sessionTimeline,
  verdictStrip,
} from "@/lib/events";
import { type CostView, ESTIMATED_SESSION, costView } from "@/lib/cost";
import {
  type TimelineCursor,
  type TimelinePage,
  appendPage,
  newestRowId,
  timelineStart,
  timelineUrl,
} from "@/lib/search";
import { EstimatedMark, PageHead, StripLegend, VerdictStrip, revealOnPhone } from "./page-parts";
import { SessionSearch, fetchJson } from "./session-search";
import { Timeline } from "./timeline";

/** The session on show: picked from the list, or opened from a search result at one of its events. */
type Picked = { id: string; agent: string; start: TimelineCursor | null; hitId: string | null };

export default function Sessions({
  snapshot,
  now,
  apiOrigin,
  projectId,
}: {
  snapshot: DashboardSnapshot;
  now: number;
  apiOrigin: string;
  projectId: string | null;
}) {
  const [picked, setPicked] = useState<Picked | null>(null);
  const detail = useRef<HTMLElement>(null);
  const focusDetail = useRef(false);
  const sessions = snapshot.sessions;
  const listed = sessions.find((session) => session.id === picked?.id);
  const shown =
    picked ?? (sessions[0] ? { id: sessions[0].id, agent: sessions[0].agent, start: null, hitId: null } : null);

  useEffect(() => setPicked(null), [projectId]);

  // After a search result opens a session, its detail sits under the results: bring it and its heading to the user.
  // This runs after the new detail has rendered; focusing before would land on the panel being replaced.
  useEffect(() => {
    if (!focusDetail.current) return;
    focusDetail.current = false;
    detail.current?.scrollIntoView({ block: "start" });
    detail.current?.querySelector<HTMLElement>("#pg-session-title")?.focus({ preventScroll: true });
  }, [picked]);

  return (
    <>
      <PageHead title="Sessions" lede="Each agent session in this project and what it did, call by call." />
      {sessions.length === 0 ? (
        <div className="pg-box">
          <p className="pg-empty">
            No sessions yet. Connect an agent from the Project page, then start it in this project.
          </p>
        </div>
      ) : (
        <>
          <SessionSearch
            apiOrigin={apiOrigin}
            projectId={projectId}
            liveEvents={snapshot.events}
            onOpen={(event: PublicEvent) => {
              focusDetail.current = true;
              setPicked({ id: event.sessionId, agent: event.agent, start: timelineStart(event), hitId: event.id });
            }}
          />
          <div className="pg-split">
            <div className="pg-box">
              <StripLegend />
              <ul className="pg-picks" aria-label="Agent sessions">
                {sessions.map((session) => (
                  <li key={session.id}>
                    <SessionPick
                      session={session}
                      events={snapshot.events}
                      usageRecorded={snapshot.counts.usageRecorded}
                      now={now}
                      current={session.id === shown?.id}
                      onPick={() => {
                        setPicked({ id: session.id, agent: session.agent, start: null, hitId: null });
                        revealOnPhone(detail.current);
                      }}
                    />
                  </li>
                ))}
              </ul>
            </div>
            {shown && (
              <section ref={detail} className="pg-box pg-detail" aria-labelledby="pg-session-title">
                <SessionDetail
                  key={`${shown.id}:${JSON.stringify(shown.start)}`}
                  picked={shown}
                  session={listed ?? (picked ? undefined : sessions[0])}
                  usageRecorded={snapshot.counts.usageRecorded}
                  liveEvents={snapshot.events}
                  now={now}
                  apiOrigin={apiOrigin}
                  projectId={projectId}
                  onFromStart={() => setPicked({ ...shown, start: null })}
                />
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}

function SessionPick({
  session,
  events,
  usageRecorded,
  now,
  current,
  onPick,
}: {
  session: DashboardSession;
  events: DashboardEvent[];
  usageRecorded: boolean;
  now: number;
  current: boolean;
  onPick: () => void;
}) {
  const timeline = sessionTimeline(events, session.id);
  const waiting = timeline.filter(
    (event) => eventStatus(event) === "Needs approval" && !ranAfterwards(event, events),
  ).length;
  const cost = costView(session, usageRecorded);
  return (
    <button type="button" className="pg-pick" aria-current={current ? "true" : undefined} onClick={onPick}>
      <span className="pg-pick-top">
        <strong>{agentLabel(session.agent)}</strong>
        <SessionState session={session} now={now} />
      </span>
      <span className="pg-pick-sub">
        {session.toolCalls} tool call{session.toolCalls === 1 ? "" : "s"}
        {session.blockedCalls > 0 && <b>, {session.blockedCalls} blocked</b>}
        {waiting > 0 && (
          <em>
            , {waiting} with no record {waiting === 1 ? "it" : "they"} ran
          </em>
        )}
      </span>
      <span className={cost.kind === "recorded" ? "pg-cost" : "pg-cost pg-cost-none"}>
        {cost.kind === "recorded" ? cost.listText : cost.text}
        {cost.kind === "recorded" && cost.estimated && <EstimatedMark note={ESTIMATED_SESSION} />}
      </span>
      <VerdictStrip marks={verdictStrip(timeline)} />
    </button>
  );
}

function SessionState({ session, now }: { session: DashboardSession; now: number }) {
  const label =
    session.status === "active"
      ? "Working"
      : session.status === "idle"
        ? `Idle, ${relativeTime(session.lastActivity, now).toLowerCase()}`
        : `Ended ${relativeTime(session.lastActivity, now).toLowerCase()}`;
  return (
    <span className={`pg-state ${session.status === "active" ? "pg-state-on" : ""}`}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

type Loaded =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "done"; events: PublicEvent[]; next: TimelineCursor | null; loadingMore: boolean };

function SessionDetail({
  picked,
  session,
  usageRecorded,
  liveEvents,
  now,
  apiOrigin,
  projectId,
  onFromStart,
}: {
  picked: Picked;
  /** Undefined when the session is older than the ones the snapshot lists. */
  session: DashboardSession | undefined;
  usageRecorded: boolean;
  liveEvents: DashboardEvent[];
  now: number;
  apiOrigin: string;
  projectId: string | null;
  onFromStart: () => void;
}) {
  const [loaded, setLoaded] = useState<Loaded>({ state: "loading" });
  const busy = useRef(false);

  const load = useCallback(
    (cursor: TimelineCursor | null | undefined) =>
      fetchJson<TimelinePage>(apiOrigin + timelineUrl(projectId, picked.id, cursor ?? undefined)),
    [apiOrigin, projectId, picked.id],
  );

  useEffect(() => {
    let current = true;
    busy.current = true;
    void load(picked.start).then((answer) => {
      busy.current = false;
      if (!current) return;
      setLoaded(
        answer.ok
          ? { state: "done", events: answer.body.events, next: answer.body.nextAfter, loadingMore: false }
          : { state: "failed", message: answer.message },
      );
    });
    return () => {
      current = false;
    };
  }, [load, picked.start]);

  async function more(cursor: TimelineCursor, shown: PublicEvent[]) {
    busy.current = true;
    const answer = await load(cursor);
    busy.current = false;
    if (!answer.ok) {
      setLoaded({ state: "failed", message: answer.message });
      return;
    }
    const page = appendPage(shown, { events: answer.body.events, next: answer.body.nextAfter });
    setLoaded({ state: "done", events: page.events, next: answer.body.nextAfter, loadingMore: false });
  }

  // A working session keeps growing: once its last page is on screen, newer live rows are fetched and added.
  const liveNewest = newestRowId(liveEvents.filter((event) => event.sessionId === picked.id));
  useEffect(() => {
    if (loaded.state !== "done" || loaded.next !== null || busy.current) return;
    if (liveNewest <= newestRowId(loaded.events)) return;
    const last = loaded.events[loaded.events.length - 1];
    void more(last ? { sequenceNum: last.sequenceNum, rowId: last.rowId } : { after: 0 }, loaded.events);
  }, [liveNewest, loaded]);

  const startedMidway = picked.start !== null && "after" in picked.start && picked.start.after > 0;
  return (
    <>
      <div className="pg-detail-head">
        <h2 id="pg-session-title" tabIndex={-1}>
          {agentLabel(session?.agent ?? picked.agent)}
        </h2>
        <code>{picked.id}</code>
        {session && (
          <span>
            started {new Date(session.startedAt).toLocaleString()}, last call{" "}
            {relativeTime(session.lastActivity, now).toLowerCase()}
          </span>
        )}
      </div>
      {session && <CostBlock view={costView(session, usageRecorded)} />}
      <div className="pg-tl-bar">
        <h3>Timeline</h3>
        {startedMidway && (
          <button type="button" className="ov-btn ov-btn-sm" onClick={onFromStart}>
            Show from the start
          </button>
        )}
      </div>
      {loaded.state === "loading" && <p className="pg-empty">Loading…</p>}
      {loaded.state === "failed" && <p className="pg-empty pg-err">{loaded.message}</p>}
      {loaded.state === "done" && (
        <>
          <Timeline
            events={loaded.events}
            label="Session timeline"
            highlightId={picked.hitId}
            emptyText="No events recorded for this session yet."
          />
          {loaded.next !== null && (
            <div className="pg-more">
              <button
                type="button"
                className="ov-btn"
                disabled={loaded.loadingMore}
                onClick={() => {
                  if (loaded.next === null) return;
                  setLoaded({ ...loaded, loadingMore: true });
                  void more(loaded.next, loaded.events);
                }}
              >
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}

function CostBlock({ view }: { view: CostView }) {
  if (view.kind !== "recorded")
    return (
      <div className="pg-costbox pg-costbox-none">
        <strong>{view.text}</strong>
        {view.help && <p className="pg-help">{view.help}</p>}
      </div>
    );
  return (
    <div className="pg-costbox">
      <h3>Cost {view.estimated && <span className="pg-est">estimated</span>}</h3>
      <dl className="pg-facts">
        {view.rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
      </dl>
      {view.estimated && <p className="pg-help">{ESTIMATED_SESSION}</p>}
    </div>
  );
}
