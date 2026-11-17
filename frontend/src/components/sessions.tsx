"use client";

import { useRef, useState } from "react";
import {
  type DashboardEvent,
  type DashboardSession,
  type DashboardSnapshot,
  agentLabel,
  eventStatus,
  ranAfterwards,
  relativeTime,
  sessionTimeline,
  verdictStrip,
} from "@/lib/events";
import { PageHead, StripLegend, VerdictStrip, revealOnPhone } from "./page-parts";
import { Timeline } from "./timeline";

export default function Sessions({ snapshot, now }: { snapshot: DashboardSnapshot; now: number }) {
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const sessions = snapshot.sessions;
  const selected = sessions.find((session) => session.id === picked) ?? sessions[0];

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
        <div className="pg-split">
          <div className="pg-box">
            <StripLegend />
            <ul className="pg-picks" aria-label="Agent sessions">
              {sessions.map((session) => (
                <li key={session.id}>
                  <SessionPick
                    session={session}
                    events={snapshot.events}
                    now={now}
                    current={session.id === selected?.id}
                    onPick={() => {
                      setPicked(session.id);
                      revealOnPhone(detail.current);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
          {selected && (
            <section ref={detail} className="pg-box pg-detail" aria-labelledby="pg-session-title">
              <SessionDetail session={selected} events={snapshot.events} now={now} />
            </section>
          )}
        </div>
      )}
    </>
  );
}

function SessionPick({
  session,
  events,
  now,
  current,
  onPick,
}: {
  session: DashboardSession;
  events: DashboardEvent[];
  now: number;
  current: boolean;
  onPick: () => void;
}) {
  const timeline = sessionTimeline(events, session.id);
  const waiting = timeline.filter(
    (event) => eventStatus(event) === "Needs approval" && !ranAfterwards(event, events),
  ).length;
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

function SessionDetail({ session, events, now }: { session: DashboardSession; events: DashboardEvent[]; now: number }) {
  const timeline = sessionTimeline(events, session.id);
  const judged = timeline.filter((event) => event.hookEventName === "PreToolUse").length;
  return (
    <>
      <div className="pg-detail-head">
        <h2 id="pg-session-title">{agentLabel(session.agent)}</h2>
        <code>{session.id}</code>
        <span>
          started {new Date(session.startedAt).toLocaleString()}, last call{" "}
          {relativeTime(session.lastActivity, now).toLowerCase()}
        </span>
      </div>
      {judged < session.toolCalls && (
        <p className="pg-note pg-note-in">
          Showing the {judged} most recent of {session.toolCalls} tool calls.
        </p>
      )}
      <Timeline events={timeline} />
    </>
  );
}
