"use client";

import { type DashboardSnapshot, type StripMark } from "@/lib/events";

export function PageHead({ title, lede }: { title: string; lede: string }) {
  return (
    <div className="pg-head">
      <h1>{title}</h1>
      <p>{lede}</p>
    </div>
  );
}

/** The backend sends only the newest events, so pages built from them must say when older ones are missing. */
export function PartialNote({ snapshot }: { snapshot: DashboardSnapshot }) {
  if (snapshot.events.length >= snapshot.counts.totalEvents) return null;
  return (
    <p className="pg-note">
      Built from the newest {snapshot.events.length.toLocaleString()} of {snapshot.counts.totalEvents.toLocaleString()}{" "}
      recorded events.
    </p>
  );
}

const MARK_WORDS: Record<StripMark, string> = {
  allowed: "allowed",
  guidance: "guidance",
  approval: "asked you",
  blocked: "blocked",
  observed: "observed",
};

export function VerdictStrip({ marks }: { marks: StripMark[] }) {
  const tally = (Object.keys(MARK_WORDS) as StripMark[])
    .map((mark) => [mark, marks.filter((m) => m === mark).length] as const)
    .filter(([, n]) => n)
    .map(([mark, n]) => `${n} ${MARK_WORDS[mark]}`)
    .join(", ");
  return (
    <span className="pg-strip" role="img" aria-label={`${marks.length} calls: ${tally || "none"}`}>
      {marks.map((mark, index) => (
        <i key={index} className={`pg-t pg-t-${mark}`} />
      ))}
    </span>
  );
}

export function StripLegend() {
  return (
    <div className="pg-legend" aria-hidden="true">
      <span>
        <i className="pg-t pg-t-allowed" />
        Allowed
      </span>
      <span>
        <i className="pg-t pg-t-guidance" />
        Guidance
      </span>
      <span>
        <i className="pg-t pg-t-approval" />
        Asked you
      </span>
      <span>
        <i className="pg-t pg-t-blocked" />
        Blocked
      </span>
    </div>
  );
}

export function CommandLine({
  label,
  command,
  onCopy,
}: {
  label: string;
  command: string;
  onCopy: (text: string, label: string) => void;
}) {
  return (
    <div className="pg-cmd">
      <span className="pg-cmd-label">{label}</span>
      <code>{command}</code>
      <button type="button" className="ov-btn ov-btn-sm" onClick={() => onCopy(command, "Command")}>
        Copy
      </button>
    </div>
  );
}

/** On a phone the detail sits under the list, so picking an item must bring the detail into view. */
export function revealOnPhone(element: HTMLElement | null) {
  if (element && window.matchMedia("(max-width: 860px)").matches) element.scrollIntoView({ block: "start" });
}
