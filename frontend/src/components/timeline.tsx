"use client";

import { useRef, useState } from "react";
import { type DashboardEvent, agentLabel, eventStatus, eventTarget } from "@/lib/events";
import { EventDetail, StatusChip, clock } from "./overview";

/** A list of calls, newest first; each row opens the same detail panel the Overview uses. */
export function Timeline({ events, showAgent = false }: { events: DashboardEvent[]; showAgent?: boolean }) {
  const [selected, setSelected] = useState<DashboardEvent | null>(null);
  const list = useRef<HTMLOListElement>(null);
  if (events.length === 0) return <p className="pg-empty">No tool calls recorded.</p>;
  return (
    <>
      <ol ref={list} className="pg-tl">
        {events.map((event) => {
          const status = eventStatus(event);
          return (
            <li key={event.id}>
              <button
                type="button"
                className="pg-tl-row"
                onClick={() => setSelected(event)}
                aria-label={`${clock(event.timestamp)} ${event.toolName} ${eventTarget(event)}, ${status}. Open details`}
              >
                <time className="ov-mono">{clock(event.timestamp)}</time>
                <StatusChip status={status} />
                <span className="pg-tl-what">
                  <span className="ov-mono pg-tl-target">
                    <span className="ov-muted">{event.toolName}</span> {eventTarget(event)}
                  </span>
                  {/* A plain pass carries a stock "passed all policies" reason that would repeat on every row. */}
                  {event.reason && status !== "Allowed" && status !== "Completed" && <small>{event.reason}</small>}
                  {showAgent && (
                    <small>
                      {agentLabel(event.agent)}, <code>{event.sessionId}</code>
                    </small>
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
      <EventDetail
        event={selected}
        onClose={() => setSelected(null)}
        fallbackFocus={() => list.current?.querySelector("button")?.focus()}
      />
    </>
  );
}
