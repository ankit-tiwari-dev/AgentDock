"use client";

import {
  type DashboardEvent,
  type DashboardSnapshot,
  agentLabel,
  approvalRequests,
  eventTarget,
  ranAfterwards,
} from "@/lib/events";
import { PageHead, PartialNote } from "./page-parts";
import { clock } from "./overview";

export default function Waiting({ snapshot, now }: { snapshot: DashboardSnapshot; now: number }) {
  const { recent, earlier, open } = approvalRequests(snapshot.events, now);
  return (
    <>
      <PageHead
        title="Waiting on you"
        lede="Every call an agent paused to ask you about. Answer in the agent's own window; this page shows what happened afterwards."
      />
      <PartialNote snapshot={snapshot} />
      <RequestGroup
        title="Last 15 minutes"
        note={`${recent.length}, ${open} with no record ${open === 1 ? "it" : "they"} ran`}
        requests={recent}
        events={snapshot.events}
        empty="Nothing has needed you in the last 15 minutes. When an agent asks before a risky change, it shows up here."
        markOpen
      />
      <RequestGroup
        title="Earlier"
        note={String(earlier.length)}
        requests={earlier}
        events={snapshot.events}
        empty="Nothing earlier."
      />
    </>
  );
}

function RequestGroup({
  title,
  note,
  requests,
  events,
  empty,
  markOpen = false,
}: {
  title: string;
  note: string;
  requests: DashboardEvent[];
  events: DashboardEvent[];
  empty: string;
  markOpen?: boolean;
}) {
  return (
    <section className="pg-group" aria-label={title}>
      <h2>
        {title} <span>{note}</span>
      </h2>
      <div className="pg-box">
        {requests.length ? (
          <ul className="pg-reqs">
            {requests.map((request) => {
              const ran = ranAfterwards(request, events);
              return (
                <li key={request.id} className={`pg-req ${markOpen && !ran ? "pg-req-open" : ""}`}>
                  <code className="pg-req-cmd">{eventTarget(request) || request.toolName}</code>
                  {request.reason && <p className="pg-req-why">{request.reason}</p>}
                  <p className="pg-req-meta">
                    {agentLabel(request.agent)}, session <code>{request.sessionId}</code>
                    {request.ruleId && (
                      <>
                        , rule <code>{request.ruleId}</code>
                      </>
                    )}
                  </p>
                  <div className="pg-req-side">
                    <time className="ov-mono" dateTime={new Date(request.timestamp).toISOString()}>
                      {clock(request.timestamp)}
                    </time>
                    <span className={ran ? "pg-ran" : "pg-not-ran"}>
                      {ran ? "✓ Ran afterwards" : "No record it ran"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="pg-empty">{empty}</p>
        )}
      </div>
    </section>
  );
}
