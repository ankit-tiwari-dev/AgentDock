"use client";

import { useMemo, useRef, useState } from "react";
import { type DashboardSnapshot, type RuleSummary, summarizeRules } from "@/lib/events";
import { CommandLine, PageHead, PartialNote, revealOnPhone } from "./page-parts";
import { StatusChip, clock } from "./overview";
import { Timeline } from "./timeline";

const VERDICTS = ["Blocked", "Needs approval", "Guidance", "Observed"];

export default function Rules({
  snapshot,
  onCopy,
}: {
  snapshot: DashboardSnapshot;
  onCopy: (text: string, label: string) => void;
}) {
  const [picked, setPicked] = useState<string | null>(null);
  const detail = useRef<HTMLElement>(null);
  const rules = useMemo(() => summarizeRules(snapshot.events), [snapshot.events]);
  const selected = rules.find((rule) => rule.id === picked) ?? rules[0];

  return (
    <>
      <PageHead
        title="Rules"
        lede="The rules that stepped in during this project's sessions, and the calls they acted on."
      />
      <PartialNote snapshot={snapshot} />
      {rules.length === 0 ? (
        <div className="pg-box">
          <p className="pg-empty">
            No rule has acted yet. A rule shows up here once it blocks, guides or asks about a call.
          </p>
        </div>
      ) : (
        <div className="pg-split">
          <ul className="pg-box pg-picks" aria-label="Rules that acted">
            {rules.map((rule) => (
              <li key={rule.id}>
                <button
                  type="button"
                  className="pg-pick"
                  aria-current={rule.id === selected?.id ? "true" : undefined}
                  onClick={() => {
                    setPicked(rule.id);
                    revealOnPhone(detail.current);
                  }}
                >
                  <span className="pg-pick-top">
                    <code>{rule.id}</code>
                    <span className="pg-state">{clock(rule.timestamp)}</span>
                  </span>
                  {rule.latestReason && <span className="pg-pick-sub">{firstLine(rule.latestReason)}</span>}
                  <VerdictCounts rule={rule} />
                </button>
              </li>
            ))}
          </ul>
          {selected && (
            <section ref={detail} className="pg-box pg-detail" aria-labelledby="pg-rule-title">
              <div className="pg-detail-head">
                <h2 id="pg-rule-title">
                  <code>{selected.id}</code>
                </h2>
                <span>
                  acted {selected.count} time{selected.count === 1 ? "" : "s"}, last at {clock(selected.timestamp)}
                </span>
              </div>
              {selected.latestReason && <p className="pg-rule-why">{selected.latestReason}</p>}
              <Timeline events={selected.events} showAgent />
            </section>
          )}
        </div>
      )}
      <section className="pg-box pg-howto" aria-labelledby="pg-howto-title">
        <h2 id="pg-howto-title">Change a rule</h2>
        <p>
          Rules live in the CLI, so this page shows what they did and the CLI changes them. Run these from the project
          folder.
        </p>
        <CommandLine label="See every rule" command="ctrlplane policies list" onCopy={onCopy} />
        <CommandLine
          label="Try a command"
          command='ctrlplane policies test --command "git push origin main"'
          onCopy={onCopy}
        />
      </section>
    </>
  );
}

function VerdictCounts({ rule }: { rule: RuleSummary }) {
  return (
    <span className="pg-counts">
      {VERDICTS.filter((verdict) => rule.counts[verdict]).map((verdict) => (
        <span key={verdict} className="pg-count">
          <StatusChip status={verdict} /> {rule.counts[verdict]}
        </span>
      ))}
    </span>
  );
}

function firstLine(text: string): string {
  return text.split("\n")[0] ?? text;
}
