"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";

type Tab = "overview" | "activity" | "sessions" | "policies" | "guide" | "reviewer" | "coach";
type DashboardEvent = {
  id: string;
  sessionId: string;
  timestamp: number;
  hookEventName: string;
  agent: string;
  projectPath: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: unknown;
  decision?: string;
  reason?: string;
  ruleId?: string;
  observedOnly: boolean;
  latencyMs?: number;
};
type DashboardSession = {
  id: string;
  agent: string;
  projectPath: string;
  status: "active" | "completed";
  startedAt: number;
  lastActivity: number;
  toolCalls: number;
  blockedCalls: number;
};
type DashboardSnapshot = {
  events: DashboardEvent[];
  sessions: DashboardSession[];
  counts: { toolCalls: number; blockedCalls: number; reviewCalls: number; activeSessions: number; totalEvents: number };
};
type Question = { id: string; question: string; whyItMatters: string; suggestedAnswers: string[] };
type LockedSpec = { title: string; overview: string; specHash: string; acceptanceCriteria: string[]; developerPrompt: string };
type Interview = { clarificationQuestions?: Question[]; lockedSpecification?: LockedSpec };
type Review = { summary: string; changes: Array<{ file: string; explanation: string }>; testsAndEvidence: string[]; risks: string[]; nextSteps: string[] };
type CoachResult = { score: number; rating: string; suggestedPrompt: string; recommendations: string[]; detectedIssues: string[] };

const EMPTY: DashboardSnapshot = { events: [], sessions: [], counts: { toolCalls: 0, blockedCalls: 0, reviewCalls: 0, activeSessions: 0, totalEvents: 0 } };
const API_ORIGIN = process.env.NEXT_PUBLIC_BACKEND_API_ORIGIN || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:45820" : "");
const NAV: { id: Tab; label: string; icon: string; group: string }[] = [
  { id: "overview", label: "Overview", icon: "◫", group: "WORKSPACE" },
  { id: "activity", label: "Live activity", icon: "⌁", group: "WORKSPACE" },
  { id: "sessions", label: "Agent sessions", icon: "◉", group: "WORKSPACE" },
  { id: "policies", label: "Policy activity", icon: "⬡", group: "GOVERNANCE" },
  { id: "guide", label: "Product guide", icon: "✳", group: "GOVERNANCE" },
  { id: "reviewer", label: "Code explainer", icon: "⌕", group: "GOVERNANCE" },
  { id: "coach", label: "Prompt coach", icon: "✧", group: "GOVERNANCE" },
];

function Icon({ children }: { children: string }) { return <span aria-hidden="true" className="icon">{children}</span>; }
function eventStatus(event: DashboardEvent) {
  if (event.hookEventName === "PostToolUse") return isToolFailure(event.toolOutput) ? "Failed" : "Completed";
  if (event.decision === "DENY") return "Blocked";
  if (event.decision === "REQUIRE_MANUAL_APPROVAL") return "Needs approval";
  if (event.decision === "INSTRUCT") return "Guidance";
  return "Allowed";
}
function isToolFailure(value: unknown) {
  if (!value || typeof value !== "object") return typeof value === "string" && /^(error|failed|exception)\b|\bexit code [1-9]/i.test(value);
  const result = value as Record<string, unknown>;
  const code = result.exit_code ?? result.exitCode ?? result.returncode ?? result.status_code;
  return result.is_error === true || result.isError === true || result.success === false || (typeof code === "number" && code !== 0) || Boolean(result.error);
}
function summarize(value: unknown) {
  if (value === undefined || value === null) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 150 ? `${text.slice(0, 147)}…` : text;
}
function relativeTime(time: number) {
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  if (seconds < 10) return "Just now";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(time).toLocaleString();
}

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [connected, setConnected] = useState(false);
  const [backendReachable, setBackendReachable] = useState(false);
  const [filter, setFilter] = useState("All events");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [prompt, setPrompt] = useState("");
  const [coachPrompt, setCoachPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [coach, setCoach] = useState<CoachResult | null>(null);
  const [interview, setInterview] = useState<Interview | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const refresh = async () => {
      try {
        const response = await fetch(`${API_ORIGIN}/api/dashboard/state`, { cache: "no-store" });
        if (!response.ok) throw new Error("Dashboard API unavailable");
        const state = await response.json() as DashboardSnapshot;
        if (!disposed) { setSnapshot(state); setBackendReachable(true); }
      } catch {
        if (!disposed) setBackendReachable(false);
      }
    };
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = process.env.NEXT_PUBLIC_BACKEND_WS_HOST || (process.env.NODE_ENV === "development" ? "127.0.0.1:45820" : window.location.host);
      try {
        socket = new WebSocket(`${protocol}//${host}/ws/events`);
        socket.onopen = () => { if (!disposed) { setConnected(true); void refresh(); } };
        socket.onmessage = (message) => {
          try {
            const event = JSON.parse(message.data);
            if (["agent_tool_executing", "agent_tool_completed", "agent_session_updated"].includes(event.type)) void refresh();
          } catch { /* Ignore malformed telemetry frames. */ }
        };
        socket.onclose = () => { if (!disposed) { setConnected(false); retry = setTimeout(connect, 2000); } };
        socket.onerror = () => socket?.close();
      } catch { if (!disposed) retry = setTimeout(connect, 2000); }
    };
    void refresh();
    connect();
    return () => { disposed = true; clearTimeout(retry); socket?.close(); };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  const visibleEvents = useMemo(() => snapshot.events.filter((event) => {
    const status = eventStatus(event);
    const matchesFilter = filter === "All events" || status === filter;
    const text = `${event.toolName || event.hookEventName} ${event.projectPath} ${event.reason || ""} ${summarize(event.toolInput)} ${event.agent} ${event.ruleId || ""}`.toLowerCase();
    return matchesFilter && text.includes(search.toLowerCase());
  }), [snapshot.events, filter, search]);
  const title = NAV.find((item) => item.id === tab)?.label || "Overview";

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${API_ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!response.ok) throw new Error((await response.json()).error || "Request failed");
    return response.json() as Promise<T>;
  }

  async function runCoach(e: FormEvent) {
    e.preventDefault(); if (!coachPrompt.trim()) return;
    setBusy(true);
    try { setCoach(await postJson<CoachResult>("/api/coach/analyze", { prompt: coachPrompt })); }
    catch { setToast("Coach service is unavailable. Check that the AgentDock backend is running."); }
    finally { setBusy(false); }
  }

  async function askGuide(e: FormEvent) {
    e.preventDefault(); if (!prompt.trim()) return;
    setBusy(true); setInterview(null);
    try {
      const result = await postJson<Interview & { isRefined?: boolean }>("/api/supervisor/interview", { featurePrompt: prompt });
      setInterview(result);
      const questions = result.clarificationQuestions || [];
      setAnswers(Object.fromEntries(questions.map((question) => [question.id, question.suggestedAnswers[0]])));
    } catch (error) { setToast(error instanceof Error ? error.message : "Supervisor Codex is unavailable. Check that Codex CLI is installed and signed in."); }
    finally { setBusy(false); }
  }

  async function lockGuide() {
    setBusy(true);
    try {
      setInterview(await postJson<Interview>("/api/supervisor/interview", { featurePrompt: prompt, developerAnswers: answers }));
      setToast("Specification locked and ready to review.");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not finalize the specification."); }
    finally { setBusy(false); }
  }

  async function explainChanges() {
    setBusy(true); setReview(null);
    try { setReview(await postJson<Review>("/api/reviewer/explain", {})); }
    catch (error) { setToast(error instanceof Error ? error.message : "Reviewer Codex is unavailable."); }
    finally { setBusy(false); }
  }

  function copy(text: string, label: string) {
    void navigator.clipboard.writeText(text).then(() => setToast(`${label} copied.`)).catch(() => setToast("Clipboard access is unavailable."));
  }

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><span>⌘</span><i /></div><div><strong>agentdock</strong><small>DEVELOPER CONTROL PLANE</small></div><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">×</button></div>
      <div className="workspace-switch"><div className="workspace-avatar">A</div><div className="workspace-name"><strong>Local workspace</strong><small>Live hook telemetry</small></div><span className={`connection-dot ${connected ? "" : "connection-off"}`} /></div>
      <div className="side-nav">{["WORKSPACE", "GOVERNANCE"].map((group) => <div key={group}><div className="nav-heading">{group}</div>{NAV.filter((item) => item.group === group).map((item) => <button key={item.id} onClick={() => { setTab(item.id); setMobileOpen(false); }} className={`nav-item ${tab === item.id ? "nav-active" : ""}`}><Icon>{item.icon}</Icon><span>{item.label}</span>{item.id === "activity" && connected && <span className="nav-live-dot" />}</button>)}</div>)}</div>
      <div className="sidebar-spacer" />
      <div className="sidebar-session"><div className="session-orbit"><span>⌁</span></div><div><strong>{connected ? "Live stream connected" : "Stream reconnecting"}</strong><small>{backendReachable ? `${snapshot.counts.totalEvents} events stored locally` : "Waiting for backend"}</small></div><span className={`green-dot ${backendReachable ? "" : "connection-off"}`} /></div>
      <div className="profile"><div className="profile-avatar">AD</div><div className="profile-details"><strong>AgentDock</strong><small>Local supervisor</small></div></div>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open menu">☰</button><span>Workspace</span><Icon>›</Icon><strong>{title}</strong></div><div className="top-actions"><div className={`connection ${connected ? "connected" : "reconnecting"}`}><span className="connection-dot" />{connected ? "Live stream connected" : "Waiting for backend"}</div><button className="help-button" onClick={() => setToast("Start AgentDock backend and install CLI hooks to receive real telemetry.")}>? <span>Setup</span></button></div></header>
      <div className="content-wrap">
        <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />LOCAL AGENT OPERATIONS</div><h1>{tab === "overview" ? "Agent activity" : title}</h1><p>{tab === "overview" ? "Live events and sessions reported by your installed agent hooks." : sectionDescription(tab)}</p></div>{tab === "overview" && <button className="primary-button" onClick={() => setTab("sessions")}><span>⌘</span> Connect an agent <kbd>→</kbd></button>}</div>

        {tab === "overview" && <>
          <section className="metric-grid"><Metric label="Active sessions" value={snapshot.counts.activeSessions} icon="◉" tone="violet" /><Metric label="Tool calls" value={snapshot.counts.toolCalls} icon="⌁" tone="blue" /><Metric label="Blocked calls" value={snapshot.counts.blockedCalls} icon="⊘" tone="rose" /><Metric label="Needs approval" value={snapshot.counts.reviewCalls} icon="◇" tone="amber" /></section>
          <section className="overview-grid"><div className="panel activity-panel"><div className="panel-heading"><div><h2>Recent hook events</h2><p>Policy decisions and tool lifecycle events received from the CLI</p></div><button className="text-button" onClick={() => setTab("activity")}>View activity <span>↗</span></button></div><div className="event-list">{snapshot.events.slice(0, 6).map((event) => <EventRow key={event.id} event={event} />)}{snapshot.events.length === 0 && <EmptyState title="No hook events received" body="Install AgentDock hooks in a project, then run an agent tool call. Events appear here as they happen." />}</div></div>
            <div className="panel session-panel"><div className="panel-heading"><div><h2>Agent sessions</h2><p>Sessions reported by your agent hooks</p></div><button className="text-button" onClick={() => setTab("sessions")}>View all <span>↗</span></button></div><div className="session-list">{snapshot.sessions.slice(0, 5).map((session) => <SessionRow key={session.id} session={session} />)}{snapshot.sessions.length === 0 && <EmptyState title="No sessions yet" body="A session is recorded when an installed agent hook runs." />}</div><ConnectHint onCopy={copy} /></div></section>
        </>}

        {tab === "activity" && <section className="panel full-panel"><div className="panel-heading activity-toolbar"><div><h2>Execution stream</h2><p>{snapshot.counts.totalEvents.toLocaleString()} persisted hook events</p></div><div className="filter-tools"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search tool, project, rule…" /></label><select value={filter} onChange={(e) => setFilter(e.target.value)}><option>All events</option><option>Allowed</option><option>Blocked</option><option>Needs approval</option><option>Guidance</option><option>Completed</option><option>Failed</option></select></div></div><div className="table-head"><span>TOOL / EVENT</span><span>AGENT</span><span>DECISION</span><span>LATENCY</span><span>WHEN</span></div><div className="event-list table-list">{visibleEvents.map((event) => <EventRow key={event.id} event={event} detailed />)}{visibleEvents.length === 0 && <EmptyState title={snapshot.events.length ? "No matching events" : "Waiting for real events"} body={snapshot.events.length ? "Try another search or decision filter." : "Once the CLI sends hook telemetry, each tool call and policy result will appear here."} />}</div></section>}

        {tab === "sessions" && <section className="panel full-panel"><div className="panel-heading"><div><h2>Recorded agent sessions</h2><p>Sessions are created and updated by SessionStart, tool, and SessionEnd hooks.</p></div></div><div className="session-cards">{snapshot.sessions.map((session) => <SessionCard key={session.id} session={session} />)}{snapshot.sessions.length === 0 && <EmptyState title="No sessions recorded" body="From a project directory, run the CLI init command for your agent and start a session." />}</div><div className="connect-panel"><div><h3>Connect a project</h3><p>Run these commands from the project you want to supervise. This installs hooks in that project’s agent configuration.</p></div><ConnectHint onCopy={copy} /></div></section>}

        {tab === "policies" && <section className="panel full-panel"><div className="panel-heading"><div><h2>Observed policy decisions</h2><p>Rules appear here when a real hook event matches them. Configure policies with the CLI.</p></div></div><div className="policy-cards">{summarizeRules(snapshot.events).map((rule) => <PolicyCard key={rule.id} rule={rule} />)}{summarizeRules(snapshot.events).length === 0 && <EmptyState title="No matched rules recorded" body="Tool calls are still counted. A rule appears here when a hook reports its matched policy ID." />}</div><div className="connect-panel"><div><h3>Policy configuration</h3><p>Use the CLI to list, inspect, and change rule settings for the current project.</p></div><button className="secondary-button" onClick={() => copy("ctrlplane policies list", "Command")}>Copy command</button></div></section>}

        {tab === "guide" && <section className="guide-layout"><div className="panel guide-panel"><div className="guide-intro"><div className="guide-mark">✳</div><div><div className="eyebrow">CODEX SUPERVISOR</div><h2>Clarify the plan<br />before coding begins.</h2><p>A read-only Codex session inspects this repository, asks product questions, and prepares a handoff for your separate developer Codex.</p></div></div><form onSubmit={askGuide} className="form-stack"><label htmlFor="feature-prompt">What would you like to build?</label><textarea id="feature-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Describe the feature or change…" /><div className="form-bottom"><span>Runs Codex CLI on this repository when submitted.</span><button className="primary-button" disabled={busy || !prompt.trim()}>{busy ? "Codex is reviewing…" : "Ask supervisor"} <span>→</span></button></div></form>{interview?.clarificationQuestions && <div className="question-stack"><div className="section-kicker">CODEX SUPERVISOR · DECISIONS TO RESOLVE</div>{interview.clarificationQuestions.map((question, index) => <div className="question-card" key={question.id}><strong><span>{String(index + 1).padStart(2, "0")}</span>{question.question}</strong><p>{question.whyItMatters}</p>{question.suggestedAnswers.map((answer) => <label className="choice" key={answer}><input type="radio" name={question.id} checked={answers[question.id] === answer} onChange={() => setAnswers((current) => ({ ...current, [question.id]: answer }))} /><span>{answer}</span></label>)}</div>)}<button className="primary-button" disabled={busy || !Object.keys(answers).length} onClick={lockGuide}>{busy ? "Preparing handoff…" : "Create developer handoff"} <span>→</span></button></div>}{interview?.lockedSpecification && <div className="locked-spec"><strong>✓ Developer handoff ready</strong><small>{interview.lockedSpecification.specHash.slice(0, 12)}</small><h3>{interview.lockedSpecification.title}</h3><p>{interview.lockedSpecification.overview}</p><ul>{interview.lockedSpecification.acceptanceCriteria.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul><h3>Prompt for your developer Codex</h3><pre className="role-output">{interview.lockedSpecification.developerPrompt}</pre><button className="secondary-button" onClick={() => copy(interview.lockedSpecification!.developerPrompt, "Developer handoff")}>Copy prompt for developer Codex</button></div>}</div><aside className="guide-aside"><div className="panel"><span className="aside-label">WORKFLOW</span><div className="workflow-step"><span>{backendReachable ? "✓" : "!"}</span><div><strong>{backendReachable ? "Backend available" : "Backend unavailable"}</strong><p>{backendReachable ? "Supervisor requests run through the local service." : "Start the backend on port 45820."}</p></div></div><div className="workflow-step"><span>01</span><div><strong>Supervisor Codex</strong><p>Inspects the repository read-only and asks contextual questions.</p></div></div><div className="workflow-step"><span>02</span><div><strong>Your developer Codex</strong><p>Paste the copied handoff into a separate interactive Codex session.</p></div></div><div className="workflow-step"><span>03</span><div><strong>Code explainer</strong><p>After implementation, ask the reviewer to explain the real diff.</p></div></div></div></aside></section>}

        {tab === "reviewer" && <section className="guide-layout"><div className="panel guide-panel"><div className="guide-intro"><div className="guide-mark">⌕</div><div><div className="eyebrow">READ-ONLY CODEX REVIEWER</div><h2>Understand what<br />the developer changed.</h2><p>After your developer Codex finishes, a separate Codex CLI run inspects the current Git diff and explains it in plain English.</p></div></div><button className="primary-button" disabled={busy} onClick={explainChanges}>{busy ? "Reviewer is inspecting…" : "Explain current changes"} <span>→</span></button>{review && <div className="role-review"><div className="review-summary"><span className="section-kicker">SUMMARY</span><p>{review.summary}</p></div><div className="review-block"><h3>Files and behavior</h3>{review.changes.length ? review.changes.map((change) => <article key={change.file}><strong>{change.file}</strong><p>{change.explanation}</p></article>) : <p>No changed files were reported.</p>}</div><div className="review-columns"><ReviewList title="Tests and evidence" items={review.testsAndEvidence} /><ReviewList title="Risks" items={review.risks} /><ReviewList title="Next steps" items={review.nextSteps} /></div></div>}</div><aside className="guide-aside"><div className="panel"><span className="aside-label">REVIEW FLOW</span><div className="workflow-step"><span>01</span><div><strong>Finish coding first</strong><p>Run your interactive developer Codex and review its result.</p></div></div><div className="workflow-step"><span>02</span><div><strong>Request explanation</strong><p>The reviewer reads git status, git diff, and changed files without editing.</p></div></div></div></aside></section>}

        {tab === "coach" && <section className="coach-layout"><div className="panel coach-panel"><div className="guide-mark">✧</div><div className="eyebrow">PROMPT COACH</div><h2>Review a prompt before<br /><span>sending it to an agent.</span></h2><p className="coach-copy">Analysis is returned by the local AgentDock coach endpoint.</p><form onSubmit={runCoach} className="form-stack"><label htmlFor="coach-prompt">Your prompt</label><textarea id="coach-prompt" value={coachPrompt} onChange={(e) => setCoachPrompt(e.target.value)} rows={7} placeholder="Paste the task you are about to send…" /><div className="form-bottom"><span>Sent to the local backend.</span><button className="primary-button" disabled={busy || !coachPrompt.trim()}>{busy ? "Analyzing…" : "Review prompt"} <span>→</span></button></div></form>{coach && <div className="coach-result"><div className="result-score"><strong>{coach.score}</strong><span>/ 100</span><i>{coach.rating.replaceAll("_", " ")}</i></div><div><strong>Recommendations</strong><ul>{coach.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>{coach.detectedIssues.length > 0 && <p className="coach-issues">{coach.detectedIssues.join(" · ")}</p>}<button className="secondary-button" onClick={() => copy(coach.suggestedPrompt, "Refined prompt")}>Copy refined prompt</button></div><pre>{coach.suggestedPrompt}</pre></div>}</div><aside className="coach-benefits"><div className="benefit"><span>⌕</span><strong>Backend-derived result</strong><p>The score and suggestions returned by your running service are shown here.</p></div><div className="benefit"><span>↻</span><strong>Try another prompt</strong><p>Submit updated wording to get a fresh analysis.</p></div></aside></section>}
      </div>
      <footer className="footer"><span>AgentDock · Local telemetry</span><span><i className={`green-dot ${backendReachable ? "" : "connection-off"}`} /> {backendReachable ? "Backend reachable" : "Backend unavailable"}</span><span>{snapshot.counts.totalEvents} events stored</span></footer>
    </main>
    {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    {toast && <div role="status" className="toast"><span>✓</span>{toast}</div>}
  </div>;
}

function Metric({ label, value, icon, tone }: { label: string; value: number; icon: string; tone: string }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value">{value.toLocaleString()}</div><div className="metric-bottom"><span>reported by local agent hooks</span></div></div>;
}

function EventRow({ event, detailed = false }: { event: DashboardEvent; detailed?: boolean }) {
  const status = eventStatus(event);
  const action = event.toolName || event.hookEventName;
  const target = event.toolInput ? summarize(event.toolInput) : event.projectPath;
  return <details className="event-disclosure"><summary><div className={`event-row ${detailed ? "event-row-detailed" : ""}`}><div className="event-main"><span className={`event-glyph ${statusTone(status)}`}>{event.hookEventName === "PostToolUse" ? "✓" : event.hookEventName === "PreToolUse" ? "⌘" : "◉"}</span><div className="event-copy"><div><strong>{action}</strong><span className="event-target">{target}</span></div><p>{event.reason || `${event.hookEventName} · ${event.projectPath || "Project path unavailable"}`}</p>{detailed && <small>{event.sessionId} · {event.ruleId || "No rule matched"}</small>}</div></div>{detailed && <span className="event-agent">{event.agent}</span>}<span className={`status-badge ${statusTone(status)}`}>{status}</span>{detailed && <><span className="event-latency">{event.latencyMs === undefined ? "—" : `${event.latencyMs.toFixed(1)} ms`}</span><span className="event-time">{relativeTime(event.timestamp)}</span></>}</div></summary><div className="event-expanded"><div className="event-metadata"><span>Agent<strong>{event.agent}</strong></span><span>Session<strong>{event.sessionId}</strong></span><span>Hook<strong>{event.hookEventName}</strong></span><span>Project<strong>{event.projectPath || "Unavailable"}</strong></span><span>Matched rule<strong>{event.ruleId || "No rule matched"}</strong></span><span>Decision<strong>{event.decision || status}</strong></span></div>{event.reason && <p className="event-reason">{event.reason}</p>}<Payload label="Tool input" value={event.toolInput} /><Payload label="Tool output" value={event.toolOutput} /></div></details>;
}

function Payload({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const content = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return <div className="event-payload"><strong>{label}</strong><pre>{content}</pre></div>;
}

function SessionRow({ session }: { session: DashboardSession }) {
  return <div className="session-row"><div className={`agent-avatar ${session.agent.includes("claude") ? "orange" : "blue"}`}>{session.agent === "claude-code" ? "✳" : "◈"}</div><div className="session-info"><div className="session-title"><strong>{session.agent}</strong><span className={`session-state ${session.status === "active" ? "working" : "review"}`}><i />{session.status}</span></div><span>{session.projectPath || "Project path unavailable"}</span><small>{session.toolCalls} tool calls · {session.blockedCalls} blocked</small></div><span className="session-time">{relativeTime(session.lastActivity)}</span></div>;
}

function SessionCard({ session }: { session: DashboardSession }) {
  return <div className="session-card"><SessionRow session={session} /><div className="session-card-stats"><div><span>TOOL CALLS</span><strong>{session.toolCalls}</strong></div><div><span>BLOCKED</span><strong>{session.blockedCalls}</strong></div><div><span>STARTED</span><strong>{new Date(session.startedAt).toLocaleString()}</strong></div></div></div>;
}

function PolicyCard({ rule }: { rule: { id: string; count: number; latestDecision: string; latestReason: string } }) {
  return <div className="policy-card"><div className={`policy-icon ${statusTone(rule.latestDecision)}`}>⬡</div><span className={`policy-state ${statusTone(rule.latestDecision)}`}>{rule.latestDecision}</span><h3>{rule.id}</h3><p>{rule.latestReason || "Matched by a recorded tool call."}</p><div className="policy-card-bottom"><span>{rule.count} observed match{rule.count === 1 ? "" : "es"}</span></div></div>;
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <div className="empty-state"><strong>{title}</strong><p>{body}</p></div>;
}

function ConnectHint({ onCopy }: { onCopy: (text: string, label: string) => void }) {
  const command = "ctrlplane init --agent all";
  return <div className="connect-hint"><span>Run from your project:</span><code>{command}</code><button className="text-button" onClick={() => onCopy(command, "Setup command")}>Copy</button></div>;
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return <div className="review-list"><h3>{title}</h3>{items.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : <p>None reported.</p>}</div>;
}

function summarizeRules(events: DashboardEvent[]) {
  const rules = new Map<string, { id: string; count: number; latestDecision: string; latestReason: string; timestamp: number }>();
  for (const event of events) {
    if (!event.ruleId) continue;
    const current = rules.get(event.ruleId);
    if (!current) rules.set(event.ruleId, { id: event.ruleId, count: 1, latestDecision: eventStatus(event), latestReason: event.reason || "", timestamp: event.timestamp });
    else {
      current.count++;
      if (event.timestamp > current.timestamp) Object.assign(current, { latestDecision: eventStatus(event), latestReason: event.reason || "", timestamp: event.timestamp });
    }
  }
  return [...rules.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function statusTone(status: string) {
  if (status === "Blocked" || status === "DENY" || status === "Failed") return "blocked";
  if (status === "Needs approval" || status === "REQUIRE_MANUAL_APPROVAL") return "review";
  if (status === "Guidance" || status === "INSTRUCT") return "guidance";
  return "allowed";
}

function sectionDescription(tab: Tab) {
  return ({ activity: "Live, persisted records of tool hooks and their policy decisions.", sessions: "Agent sessions seen by your installed hooks.", policies: "Policy rules observed in actual tool-call decisions.", guide: "Resolve product decisions with a read-only Codex supervisor.", reviewer: "Get a plain-English explanation from a separate read-only Codex reviewer.", coach: "Analyze prompts through the local coach API." } as Record<string, string>)[tab] || "AgentDock workspace.";
}
