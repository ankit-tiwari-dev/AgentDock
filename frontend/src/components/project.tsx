"use client";

import { type DashboardSnapshot, formatUptime } from "@/lib/events";
import { CommandLine, PageHead } from "./page-parts";

export type Health = { version?: string; uptimeSeconds?: number; codexEnabled?: boolean };

const AGENTS = [
  ["Claude Code", "claude"],
  ["Codex", "codex"],
  ["OpenCode", "opencode"],
  ["All three", "all"],
] as const;

export default function Project({
  snapshot,
  health,
  connected,
  backendReachable,
  onCopy,
}: {
  snapshot: DashboardSnapshot;
  health: Health | null;
  connected: boolean;
  backendReachable: boolean;
  onCopy: (text: string, label: string) => void;
}) {
  const source = snapshot.source;
  return (
    <>
      <PageHead
        title="Project"
        lede="Which project this dashboard is watching, and how to connect your agents to it."
      />
      <div className="pg-two">
        <section className="pg-box" aria-labelledby="pg-this">
          <div className="pg-detail-head">
            <h2 id="pg-this">This dashboard</h2>
          </div>
          <dl className="pg-facts">
            <dt>Project</dt>
            <dd>{source ? <code>{source.projectPath}</code> : "Not loaded yet"}</dd>
            <dt>Audit log</dt>
            <dd>
              {source?.available ? (
                <>
                  <span className="pg-good">Found</span>, <code>{source.databasePath}</code>
                </>
              ) : source ? (
                <>
                  <span className="pg-warn">Not found</span> at <code>{source.databasePath}</code>. Run{" "}
                  <code>ctrlplane init</code> and <code>ctrlplane start</code> in that project, or restart the backend
                  with <code>--project &lt;path&gt;</code>.
                </>
              ) : (
                "Not loaded yet"
              )}
            </dd>
            <dt>Calls recorded</dt>
            <dd>
              {snapshot.counts.toolCalls.toLocaleString()} in {snapshot.sessions.length} session
              {snapshot.sessions.length === 1 ? "" : "s"}
            </dd>
            <dt>Live updates</dt>
            <dd>
              {connected ? <span className="pg-good">Connected</span> : <span className="pg-warn">Reconnecting</span>}
            </dd>
            <dt>Backend</dt>
            <dd>
              {backendReachable && health ? (
                <>
                  Version {health.version ?? "unknown"}
                  {health.uptimeSeconds !== undefined && `, running ${formatUptime(health.uptimeSeconds)}`}
                </>
              ) : (
                <span className="pg-warn">Not reachable</span>
              )}
            </dd>
            <dt>Codex</dt>
            <dd>
              {health?.codexEnabled ? (
                <>
                  <span className="pg-good">On</span>. Plan &amp; review asks a read-only Codex run.
                </>
              ) : (
                <>
                  <span className="pg-warn">Off</span>. Plan &amp; review uses the built-in supervisor; set{" "}
                  <code>AGENTDOCK_CODEX=1</code> to use Codex.
                </>
              )}
            </dd>
          </dl>
        </section>
        <section className="pg-box pg-howto" aria-labelledby="pg-connect">
          <h2 id="pg-connect">Connect an agent</h2>
          <p>
            Run one of these in the project folder. It installs AgentDock&apos;s hooks into that agent&apos;s settings
            for this project only.
          </p>
          {AGENTS.map(([label, agent]) => (
            <CommandLine key={agent} label={label} command={`ctrlplane init --agent ${agent}`} onCopy={onCopy} />
          ))}
        </section>
      </div>
    </>
  );
}
