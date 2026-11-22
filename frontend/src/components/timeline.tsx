"use client";

import { useRef, useState } from "react";
import { type DashboardEvent, type PublicEvent, agentLabel, blobNote, eventTarget, timelineChip } from "@/lib/events";
import { EventDetail, StatusChip, clock } from "./overview";

type Row = DashboardEvent | PublicEvent;

/**
 * A list of events; each row opens the same detail panel the Overview uses, or calls `onPick` instead.
 * Tool calls show their verdict; prompts, stops and other hooks show what happened.
 */
export function Timeline({
  events,
  showAgent = false,
  showDate = false,
  highlightId,
  onPick,
  label,
  emptyText = "No tool calls recorded.",
}: {
  events: Row[];
  showAgent?: boolean;
  showDate?: boolean;
  highlightId?: string | null;
  onPick?: (event: Row) => void;
  label?: string;
  emptyText?: string;
}) {
  const [selected, setSelected] = useState<DashboardEvent | null>(null);
  const list = useRef<HTMLOListElement>(null);
  if (events.length === 0) return <p className="pg-empty">{emptyText}</p>;
  return (
    <>
      <ol ref={list} className="pg-tl" aria-label={label}>
        {events.map((event) => {
          const chip = timelineChip(event);
          const what = event.toolName ?? event.hookEventName;
          const target = event.toolName ? eventTarget(event) : "";
          const blob = "sequenceNum" in event ? blobNote(event) : null;
          const hit = event.id === highlightId;
          const day = showDate ? new Date(event.timestamp).toLocaleDateString() : "";
          return (
            <li key={event.id}>
              <button
                type="button"
                className={hit ? "pg-tl-row pg-hit" : "pg-tl-row"}
                aria-current={hit ? "true" : undefined}
                onClick={() => (onPick ? onPick(event) : setSelected(event))}
              >
                <time className="ov-mono" dateTime={new Date(event.timestamp).toISOString()}>
                  {day && <span className="pg-tl-date">{day}</span>}
                  {clock(event.timestamp)}
                </time>
                {chip.tone === "status" ? (
                  <StatusChip status={chip.label} />
                ) : (
                  <span className="ov-chip pg-chip-event">{chip.label}</span>
                )}
                <span className="pg-tl-what">
                  <span className="ov-mono pg-tl-target">
                    <span className="ov-muted">{what}</span> {target}
                  </span>
                  {/* A plain pass carries a stock "passed all policies" reason that would repeat on every row. */}
                  {event.reason && chip.label !== "Allowed" && chip.label !== "Completed" && (
                    <small>{event.reason}</small>
                  )}
                  {blob && <small className="pg-blob">{blob}</small>}
                  {showAgent && (
                    <small>
                      {agentLabel(event.agent)}, <code>{event.sessionId}</code>
                    </small>
                  )}
                </span>
                {/* The visible text names the row (WCAG 2.5.3); the action follows it for a screen reader. */}
                <span className="sr-only">. {onPick ? "Open this session at this event" : "Open details"}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {!onPick && (
        <EventDetail
          event={selected}
          onClose={() => setSelected(null)}
          fallbackFocus={() => list.current?.querySelector("button")?.focus()}
        />
      )}
    </>
  );
}
