/**
 * Times live-view reads on a database made by bench-seed.ts: 50 runs per group, p95 printed.
 * Targets: search under 500 ms, timeline under 200 ms per page.
 * Run: node scripts/bench-live-view.ts <audit.db>
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditReader } from "../backend/src/audit-reader.ts";
import { parseSearchQuery, parseTimelineQuery } from "../backend/src/event-query.ts";

const source = process.argv[2];
if (!source) throw new Error("usage: node scripts/bench-live-view.ts <audit.db>");
const dir = mkdtempSync(join(tmpdir(), "agentdock-bench-"));
mkdirSync(join(dir, ".ctrlplane"));
copyFileSync(source, join(dir, ".ctrlplane", "audit.db"));
const reader = new AuditReader(dir);

const search = (qs: string) => {
  const p = parseSearchQuery(new URLSearchParams(qs));
  if (!p.ok) throw new Error(p.error);
  return reader.searchEvents(p.value);
};
const timeline = (qs: string) => {
  const p = parseTimelineQuery(new URLSearchParams(qs));
  if (!p.ok) throw new Error(p.error);
  return reader.sessionTimeline("bench-0", p.value)!;
};

// The cursor for a deep page: ten pages into a broad search.
let deep = search("q=build");
for (let i = 0; i < 10 && deep.nextBefore; i++) deep = search(`q=build&before=${deep.nextBefore}`);
const middle = timeline("after=5000");

const groups: [string, () => unknown][] = [
  ["search q only (common word)", () => search("q=handler-1")],
  ["search q only (rare, oldest event)", () => search("q=needle-zz9")],
  ["search q only (no match)", () => search("q=zzzz-not-there")],
  [
    "search q + all filters",
    () => search("q=npm run&agent=claude-code&verdict=DENY&tool=Bash&from=1760000000000&to=1760090000000"),
  ],
  ["search filters only", () => search("verdict=DENY&tool=Bash&agent=codex")],
  ["search Windows path", () => search(`q=${encodeURIComponent("C:\\work\\app")}`)],
  ["search deep Load more", () => search(`q=build&before=${deep.nextBefore ?? 1}`)],
  ["timeline first page", () => timeline("")],
  ["timeline middle page", () => timeline(`after=${middle.events[0].sequenceNum}`)],
  ["timeline last page", () => timeline("after=9900")],
  ["snapshot (with usage)", () => reader.snapshot()],
];

const results: Record<string, { p50: number; p95: number; max: number }> = {};
for (const [name, run] of groups) {
  run();
  const times: number[] = [];
  for (let i = 0; i < 50; i++) {
    const t0 = performance.now();
    run();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => Math.round(times[Math.min(times.length - 1, Math.floor(q * times.length))] * 10) / 10;
  results[name] = { p50: at(0.5), p95: at(0.95), max: at(1) };
}
reader.close();
rmSync(dir, { recursive: true, force: true });
for (const [name, r] of Object.entries(results))
  console.log(`${name.padEnd(38)} p50 ${r.p50} ms  p95 ${r.p95} ms  max ${r.max} ms`);
