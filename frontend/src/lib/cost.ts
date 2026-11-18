// What the dashboard shows for token use and cost. No React, so the Node test runner can load it directly.
// A missing value is never shown as $0 or 0 tokens: a zero would claim something was measured.
import { type DashboardSession, type DashboardSnapshot, agentLabel } from "./events.ts";

export const COST_HELP = "Cost is recorded each time Claude Code stops, while the ctrlplane daemon is running.";
export const OLD_CLI_TEXT = "Cost not recorded: update the CLI";
export const OLD_CLI_HELP = "Cost needs ctrlplane 0.3.0 or later.";
export const ESTIMATED_SESSION = "A model in this session is not in the price list, so its cost uses a fallback price.";
export const ESTIMATED_PROJECT =
  "A model in some sessions is not in the price list, so part of this cost uses a fallback price.";

type Missing = { kind: "not-available" | "not-recorded" | "cli-too-old"; text: string; help?: string };

export type CostView =
  | {
      kind: "recorded";
      costText: string;
      /** The short form for the Sessions list: "$1.84 · 1.2M tokens". */
      listText: string;
      /** Label and value pairs for the session detail. */
      rows: [string, string][];
      estimated: boolean;
      text?: undefined;
      help?: undefined;
    }
  | Missing;

export function costView(session: DashboardSession, usageRecorded: boolean): CostView {
  // Only Claude Code sessions have a transcript the CLI can price.
  if (session.agent !== "claude-code")
    return { kind: "not-available", text: `Cost not available for ${agentLabel(session.agent)}` };
  if (!usageRecorded) return { kind: "cli-too-old", text: OLD_CLI_TEXT, help: OLD_CLI_HELP };
  const usage = session.usage;
  if (usage) {
    const tokens = usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
    const costText = formatUsd(usage.costUsd);
    return {
      kind: "recorded",
      costText,
      listText: `${costText} · ${formatTokens(tokens)} tokens`,
      rows: [
        ["Total", costText],
        ["Input", tokenText(usage.inputTokens)],
        ["Output", tokenText(usage.outputTokens)],
        ["Cache read", tokenText(usage.cacheReadTokens)],
        ["Cache write", tokenText(usage.cacheCreationTokens)],
        ["Models", usage.models.join(", ")],
      ],
      estimated: usage.estimated,
    };
  }
  if (!session.hasTranscript) return { kind: "not-available", text: "Cost not available for Claude Code" };
  return {
    kind: "not-recorded",
    text: session.status === "active" ? "Cost not recorded yet" : "Cost not recorded",
    help: COST_HELP,
  };
}

export type ProjectCostView =
  | { kind: "recorded"; costText: string; sub: string; estimated: boolean; text?: undefined; help?: undefined }
  | { kind: "none" | "cli-too-old"; text: string; help?: string; sub?: undefined };

export function projectCostView(counts: Pick<DashboardSnapshot["counts"], "usage" | "usageRecorded">): ProjectCostView {
  if (!counts.usageRecorded) return { kind: "cli-too-old", text: OLD_CLI_TEXT, help: OLD_CLI_HELP };
  if (!counts.usage) return { kind: "none", text: "No cost recorded yet", help: COST_HELP };
  const n = counts.usage.sessions;
  return {
    kind: "recorded",
    costText: formatUsd(counts.usage.costUsd),
    sub: `across ${n.toLocaleString("en-US")} session${n === 1 ? "" : "s"}`,
    estimated: counts.usage.estimated,
  };
}

/** A recorded zero stays $0.00; only a cost above zero and under a cent becomes <$0.01. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatTokens(n: number): string {
  const short = (value: number, unit: string) =>
    `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}${unit}`;
  if (n >= 1_000_000) return short(n / 1_000_000, "M");
  if (n >= 1_000) return short(n / 1_000, "k");
  return String(n);
}

function tokenText(n: number): string {
  return `${n.toLocaleString("en-US")} tokens`;
}
