"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

type EventItem = { id: string; action: string; target: string; detail: string; status: "Allowed" | "Blocked" | "Review"; time: string; latency: string; source: string };
type Tab = "overview" | "activity" | "sessions" | "policies" | "guide" | "coach";
const backendApiOrigin = process.env.NEXT_PUBLIC_BACKEND_API_ORIGIN || (process.env.NODE_ENV === "development" ? "http://127.0.0.1:45820" : "");

const initialEvents: EventItem[] = [
  { id: "evt-2048", action: "Write", target: "src/auth/session.ts", detail: "Added refresh token rotation with single-use token checks", status: "Allowed", time: "Just now", latency: "0.14 ms", source: "Claude Code" },
  { id: "evt-2047", action: "Bash", target: "rm -rf ./coverage", detail: "Destructive path is outside the approved workspace scope", status: "Blocked", time: "2 min ago", latency: "0.08 ms", source: "Claude Code" },
  { id: "evt-2046", action: "Read", target: "src/auth/session.test.ts", detail: "Inspected refresh token test coverage", status: "Allowed", time: "4 min ago", latency: "0.11 ms", source: "Claude Code" },
  { id: "evt-2045", action: "Edit", target: "src/routes/auth.ts", detail: "Updated session response and cookie options", status: "Review", time: "7 min ago", latency: "0.17 ms", source: "Cursor" },
  { id: "evt-2044", action: "Bash", target: "npm test -- --runInBand", detail: "Test command started in supervised workspace", status: "Allowed", time: "9 min ago", latency: "0.12 ms", source: "Cursor" },
];

const navigation: { id: Tab; label: string; icon: string; group: string }[] = [
  { id: "overview", label: "Overview", icon: "◫", group: "WORKSPACE" },
  { id: "activity", label: "Live activity", icon: "⌁", group: "WORKSPACE" },
  { id: "sessions", label: "Agent sessions", icon: "◉", group: "WORKSPACE" },
  { id: "policies", label: "Policy center", icon: "⬡", group: "GOVERNANCE" },
  { id: "guide", label: "Product guide", icon: "✳", group: "GOVERNANCE" },
  { id: "coach", label: "Prompt coach", icon: "✧", group: "GOVERNANCE" },
];

function Icon({ children, className = "" }: { children: string; className?: string }) { return <span aria-hidden="true" className={`icon ${className}`}>{children}</span>; }

export default function Dashboard() {
  const [tab, setTab] = useState<Tab>("overview");
  const [events, setEvents] = useState(initialEvents);
  const [connection, setConnection] = useState<"connected" | "reconnecting">("reconnecting");
  const [filter, setFilter] = useState("All events");
  const [search, setSearch] = useState("");
  const [toast, setToast] = useState("");
  const [prompt, setPrompt] = useState("");
  const [coachPrompt, setCoachPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [coach, setCoach] = useState<{ score: number; rating: string; suggestedPrompt: string; recommendations: string[] } | null>(null);
  const [interview, setInterview] = useState<{ questions?: { id: string; question: string; whyItMatters: string; suggestedAnswers: string[] }[]; lockedSpecification?: { title: string; overview: string; specHash: string; acceptanceCriteria: string[] } } | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host = process.env.NEXT_PUBLIC_BACKEND_WS_HOST || (process.env.NODE_ENV === "development" ? "127.0.0.1:45820" : window.location.host);
      try {
        socket = new WebSocket(`${protocol}//${host}/ws/events`);
        socket.onopen = () => setConnection("connected");
        socket.onmessage = (event) => {
          try {
            const message = JSON.parse(event.data);
            const incoming: EventItem = { id: `evt-${Date.now()}`, action: message.type || "Event", target: message.data?.path || "Agent runtime", detail: JSON.stringify(message.data || message), status: "Allowed", time: "Just now", latency: "—", source: message.data?.agent || "AgentDock" };
            setEvents((current) => [incoming, ...current].slice(0, 30));
          } catch { /* Ignore malformed telemetry frames. */ }
        };
        socket.onclose = () => { setConnection("reconnecting"); if (!disposed) retry = setTimeout(connect, 3000); };
        socket.onerror = () => socket?.close();
      } catch { setConnection("reconnecting"); retry = setTimeout(connect, 3000); }
    };
    connect();
    return () => { disposed = true; clearTimeout(retry); socket?.close(); };
  }, []);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(""), 2600); return () => clearTimeout(timer); }, [toast]);

  const visibleEvents = useMemo(() => events.filter((event) => {
    const matchesFilter = filter === "All events" || event.status === filter;
    const term = search.toLowerCase();
    return matchesFilter && `${event.action} ${event.target} ${event.detail} ${event.source}`.toLowerCase().includes(term);
  }), [events, filter, search]);

  async function runCoach(e: FormEvent) {
    e.preventDefault(); if (!coachPrompt.trim()) return;
    setBusy(true);
    try { const response = await fetch(`${backendApiOrigin}/api/coach/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: coachPrompt }) }); if (!response.ok) throw new Error(); setCoach(await response.json()); }
    catch { setToast("Could not reach the coach service. Check the AgentDock backend connection."); }
    finally { setBusy(false); }
  }

  async function askGuide(e: FormEvent) {
    e.preventDefault(); if (!prompt.trim()) return;
    setBusy(true); setInterview(null);
    try { const response = await fetch(`${backendApiOrigin}/api/supervisor/interview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ featurePrompt: prompt }) }); if (!response.ok) throw new Error(); const data = await response.json(); if (data.clarificationQuestions) { setInterview({ questions: data.clarificationQuestions }); setAnswers(Object.fromEntries(data.clarificationQuestions.map((q: { id: string; suggestedAnswers: string[] }) => [q.id, q.suggestedAnswers[0]]))); } else if (data.lockedSpecification) setInterview(data); }
    catch { setToast("Could not reach the product guide. Check the AgentDock backend connection."); }
    finally { setBusy(false); }
  }

  async function lockGuide() {
    setBusy(true);
    try { const response = await fetch(`${backendApiOrigin}/api/supervisor/interview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ featurePrompt: prompt, developerAnswers: answers }) }); if (!response.ok) throw new Error(); setInterview(await response.json()); setToast("Specification locked and ready for your coding agent."); }
    catch { setToast("Could not lock the specification. Check the backend connection."); }
    finally { setBusy(false); }
  }

  const title = navigation.find((item) => item.id === tab)?.label || "Overview";
  const blockedCount = events.filter((event) => event.status === "Blocked").length;
  const allowedCount = events.filter((event) => event.status === "Allowed").length;

  return <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? "sidebar-open" : ""}`}>
      <div className="brand"><div className="brand-mark"><span>⌘</span><i /></div><div><strong>agentdock</strong><small>DEVELOPER CONTROL PLANE</small></div><button className="mobile-close" onClick={() => setMobileOpen(false)} aria-label="Close menu">×</button></div>
      <div className="workspace-switch"><div className="workspace-avatar">A</div><div className="workspace-name"><strong>Acme workspace</strong><small>Personal workspace</small></div><Icon>⌄</Icon></div>
      <div className="side-nav">{["WORKSPACE", "GOVERNANCE"].map((group) => <div key={group}><div className="nav-heading">{group}</div>{navigation.filter((item) => item.group === group).map((item) => <button key={item.id} onClick={() => { setTab(item.id); setMobileOpen(false); }} className={`nav-item ${tab === item.id ? "nav-active" : ""}`}><Icon>{item.icon}</Icon><span>{item.label}</span>{item.id === "activity" && <span className="nav-live-dot" />}{item.id === "policies" && <span className="nav-count">4</span>}</button>)}</div>)}
      </div>
      <div className="sidebar-spacer" />
      <div className="sidebar-session"><div className="session-orbit"><span>✳</span></div><div><strong>Session protected</strong><small>All policies active</small></div><span className="green-dot" /></div>
      <button className="profile"><div className="profile-avatar">AT</div><div className="profile-details"><strong>Ankit Tiwari</strong><small>Developer</small></div><Icon>···</Icon></button>
    </aside>

    <main className="main-shell">
      <header className="topbar"><div className="breadcrumbs"><button className="mobile-menu" onClick={() => setMobileOpen(true)} aria-label="Open menu">☰</button><span>Workspace</span><Icon>›</Icon><strong>{title}</strong></div><div className="top-actions"><div className={`connection ${connection}`}><span className="connection-dot" />{connection === "connected" ? "Daemon connected" : "Waiting for daemon"}</div><button className="icon-button" aria-label="Notifications" onClick={() => setToast("You’re all caught up.")}>♧<i className="notification-dot" /></button><div className="top-divider" /><button className="help-button" onClick={() => setToast("AgentDock help center is coming soon.")}>? <span>Help</span></button></div></header>
      <div className="content-wrap">
        <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line" />YOUR AGENT OPERATIONS</div><h1>{tab === "overview" ? <>Good afternoon, Ankit <span className="wave">✳</span></> : title}</h1><p>{tab === "overview" ? "A clear view of what your AI agents are doing, right now." : sectionDescription(tab)}</p></div><button className="primary-button" onClick={() => { setTab("sessions"); setToast("New supervised session setup is ready."); }}><span>＋</span> New session <kbd>⌘ K</kbd></button></div>

        {tab === "overview" && <>
          <section className="metric-grid">
            <Metric label="Active sessions" value="02" trend="+1" hint="vs. last 24 hours" icon="◉" tone="violet" spark={[3,5,4,7,5,8,7,10,8,11,9,13]} />
            <Metric label="Tool invocations" value={String(2048 + events.length - initialEvents.length)} trend="12.8%" hint="vs. last 24 hours" icon="⌁" tone="blue" spark={[5,4,7,6,8,6,9,10,8,11,10,13]} />
            <Metric label="Policy blocks" value={String(blockedCount)} trend="Protected" hint="actions stopped today" icon="⬡" tone="rose" spark={[8,7,8,5,7,4,5,3,4,2,3,2]} />
            <Metric label="Token spend" value="$4.82" trend="−8.4%" hint="$0.36 saved by Coach" icon="✧" tone="amber" spark={[9,8,10,7,8,6,7,5,6,5,4,3]} />
          </section>

          <section className="overview-grid">
            <div className="panel activity-panel"><div className="panel-heading"><div><h2>Live activity</h2><p>Real-time decisions across your agents</p></div><button className="text-button" onClick={() => setTab("activity")}>View all <span>↗</span></button></div><div className="event-list">{events.slice(0, 4).map((event) => <EventRow key={event.id} event={event} />)}</div><button className="panel-footer" onClick={() => setTab("activity")}>View all activity <span>→</span></button></div>
            <div className="panel session-panel"><div className="panel-heading"><div><h2>Agent sessions <span className="count-pill">2</span></h2><p>Your supervised workspaces</p></div><button className="more-button" onClick={() => setTab("sessions")}>···</button></div><div className="session-list"><Session name="Claude Code" project="acme / api-platform" branch="feat/session-rotation" color="orange" status="Working" time="Active now" /><Session name="Cursor" project="acme / web-dashboard" branch="fix/navigation-state" color="blue" status="Needs review" time="8 min ago" /></div><button className="add-session" onClick={() => setToast("New supervised session setup is ready.")}><span>＋</span> Add an agent session</button></div>
          </section>

          <section className="bottom-grid"><div className="panel policy-panel"><div className="panel-heading"><div><h2>Policy overview</h2><p>Your guardrails at a glance</p></div><button className="text-button" onClick={() => setTab("policies")}>Manage policies <span>↗</span></button></div><div className="policy-summary"><div className="policy-score"><div className="score-ring"><strong>98<span>%</span></strong></div><div><strong>Excellent coverage</strong><small>Your workspace is well protected</small></div></div><div className="policy-breakdown"><div><span className="legend-dot allow" />Allowed <strong>{allowedCount}</strong></div><div><span className="legend-dot blocked" />Blocked <strong>{blockedCount}</strong></div><div><span className="legend-dot review" />Needs review <strong>{events.filter((event) => event.status === "Review").length}</strong></div></div></div></div><div className="panel insight-panel"><div className="insight-icon">✧</div><div><span className="insight-label">AGENTDOCK INSIGHT</span><h3>One less retry loop, already.</h3><p>Prompt Coach helped clarify a task before it reached your agent. That saved an estimated <strong>1,240 tokens</strong> today.</p><button className="text-button" onClick={() => setTab("coach")}>Open Prompt Coach <span>→</span></button></div><div className="insight-glow" /></div></section>
        </>}

        {tab === "activity" && <section className="panel full-panel"><div className="panel-heading activity-toolbar"><div><h2>Execution stream</h2><p>{events.length.toLocaleString()} events monitored in this session</p></div><div className="filter-tools"><label className="search-box"><span>⌕</span><input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search events..." /><kbd>⌘ F</kbd></label><select value={filter} onChange={(e) => setFilter(e.target.value)}><option>All events</option><option>Allowed</option><option>Blocked</option><option>Review</option></select></div></div><div className="table-head"><span>TOOL / TARGET</span><span>AGENT</span><span>DECISION</span><span>LATENCY</span><span>WHEN</span></div><div className="event-list table-list">{visibleEvents.map((event) => <EventRow key={event.id} event={event} detailed />)}{visibleEvents.length === 0 && <div className="empty-state">No events match this search.</div>}</div></section>}

        {tab === "sessions" && <section className="panel full-panel"><div className="panel-heading"><div><h2>Supervised agent sessions</h2><p>Each session is monitored against your workspace policies.</p></div><button className="primary-button compact" onClick={() => setToast("New supervised session setup is ready.")}><span>＋</span> Add session</button></div><div className="session-cards"><SessionCard name="Claude Code" project="api-platform" branch="feat/session-rotation" color="orange" status="Working" time="Started 24 min ago" /><SessionCard name="Cursor" project="web-dashboard" branch="fix/navigation-state" color="blue" status="Needs review" time="Started 1 hr ago" /></div></section>}

        {tab === "policies" && <section className="panel full-panel"><div className="panel-heading"><div><h2>Workspace policy center</h2><p>Rules are enforced locally before tool calls reach your environment.</p></div><button className="secondary-button" onClick={() => setToast("Policy editor opened in read-only preview.")}>＋ Add policy</button></div><div className="policy-cards"><PolicyCard icon="⌘" name="Destructive commands" description="Prevent irreversible shell commands and unsafe filesystem operations." state="ENFORCED" tone="rose" count="12 rules" /><PolicyCard icon="✓" name="Test integrity" description="Protect test suites from being weakened or bypassed during implementation." state="ENFORCED" tone="green" count="8 rules" /><PolicyCard icon="◫" name="Workspace boundaries" description="Keep agent reads and writes within approved project paths." state="ENFORCED" tone="blue" count="4 rules" /><PolicyCard icon="✧" name="Human review gates" description="Require a developer decision for sensitive or high impact actions." state="ACTIVE" tone="amber" count="3 rules" /></div></section>}

        {tab === "guide" && <section className="guide-layout"><div className="panel guide-panel"><div className="guide-intro"><div className="guide-mark">✳</div><div><div className="eyebrow">PRODUCT GUIDE · AGENT 3</div><h2>Make the plan clear<br />before the code begins.</h2><p>Turn a rough idea into a concrete specification your coding agent can follow. The guide asks the important questions first.</p></div></div><form onSubmit={askGuide} className="form-stack"><label htmlFor="feature-prompt">What would you like to build?</label><textarea id="feature-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5} placeholder="Describe the feature or change…\n\nFor example: Add Google OAuth login with refresh token rotation." /><div className="form-bottom"><span>Be as specific or as high-level as you like.</span><button className="primary-button" disabled={busy || !prompt.trim()}>{busy ? "Thinking…" : "Clarify this idea"} <span>→</span></button></div></form>
          {interview?.questions && <div className="question-stack"><div className="section-kicker">A FEW DECISIONS TO MAKE</div>{interview.questions.map((q, i) => <div className="question-card" key={q.id}><strong><span>{String(i + 1).padStart(2, "0")}</span>{q.question}</strong><p>{q.whyItMatters}</p>{q.suggestedAnswers.map((answer) => <label className="choice" key={answer}><input type="radio" name={q.id} checked={answers[q.id] === answer} onChange={() => setAnswers((a) => ({ ...a, [q.id]: answer }))} /><span>{answer}</span></label>)}</div>)}<button className="primary-button" disabled={busy} onClick={lockGuide}>Lock specification <span>→</span></button></div>}
          {interview?.lockedSpecification && <div className="locked-spec"><strong>✓ Specification locked</strong><small>{interview.lockedSpecification.specHash?.slice(0, 12)}</small><h3>{interview.lockedSpecification.title}</h3><p>{interview.lockedSpecification.overview}</p><ul>{interview.lockedSpecification.acceptanceCriteria?.map((criterion) => <li key={criterion}>{criterion}</li>)}</ul></div>}
        </div><aside className="guide-aside"><div className="panel"><span className="aside-label">THE WORKFLOW</span><div className="workflow-step"><span>01</span><div><strong>Describe the intent</strong><p>Start with the change you have in mind.</p></div></div><div className="workflow-step"><span>02</span><div><strong>Resolve decisions</strong><p>Clarify behavior, edge cases, and constraints.</p></div></div><div className="workflow-step"><span>03</span><div><strong>Lock the spec</strong><p>Give your coding agent a stable contract.</p></div></div></div><div className="guide-note">Your specification stays in this workspace and can be reviewed before dispatch.</div></aside></section>}

        {tab === "coach" && <section className="coach-layout"><div className="panel coach-panel"><div className="guide-mark">✧</div><div className="eyebrow">PROMPT COACH</div><h2>Better instructions.<br /><span>Fewer expensive retries.</span></h2><p className="coach-copy">Get a quick, private review of your task before it goes to a coding agent. Spot missing context, fuzzy scope, and unclear success criteria.</p><form onSubmit={runCoach} className="form-stack"><label htmlFor="coach-prompt">Your prompt</label><textarea id="coach-prompt" value={coachPrompt} onChange={(e) => setCoachPrompt(e.target.value)} rows={7} placeholder="Paste the task you’re about to send to your coding agent…" /><div className="form-bottom"><span>Only sent to your configured AgentDock coach.</span><button className="primary-button" disabled={busy || !coachPrompt.trim()}>{busy ? "Analyzing…" : "Review prompt"} <span>→</span></button></div></form>{coach && <div className="coach-result"><div className="result-score"><strong>{coach.score}</strong><span>/ 100</span><i>{coach.rating?.replaceAll("_", " ")}</i></div><div><strong>Suggested improvements</strong><ul>{coach.recommendations?.map((rec) => <li key={rec}>{rec}</li>)}</ul><button className="secondary-button" onClick={() => { navigator.clipboard.writeText(coach.suggestedPrompt); setToast("Improved prompt copied to clipboard."); }}>Copy refined prompt</button></div><pre>{coach.suggestedPrompt}</pre></div>}</div><aside className="coach-benefits"><div className="benefit"><span>⌕</span><strong>Find the ambiguity</strong><p>Catch vague asks before they become expensive loops.</p></div><div className="benefit"><span>◫</span><strong>Set clear boundaries</strong><p>Help your agent understand scope and constraints.</p></div><div className="benefit"><span>✓</span><strong>Define done</strong><p>Give your task measurable acceptance criteria.</p></div></aside></section>}
      </div>
      <footer className="footer"><span>© 2026 AgentDock</span><span><i className="green-dot" /> All systems operational</span><span>Local-first agent supervision</span></footer>
    </main>
    {mobileOpen && <button className="scrim" onClick={() => setMobileOpen(false)} aria-label="Close navigation" />}
    {toast && <div role="status" className="toast"><span>✓</span>{toast}</div>}
  </div>;
}

function Metric({ label, value, trend, hint, icon, tone, spark }: { label: string; value: string; trend: string; hint: string; icon: string; tone: string; spark: number[] }) {
  return <div className="metric-card"><div className="metric-top"><span>{label}</span><span className={`metric-icon ${tone}`}>{icon}</span></div><div className="metric-value">{value}</div><div className="metric-bottom"><span className={`metric-trend ${tone}`}>{trend}</span><span>{hint}</span><svg viewBox="0 0 80 26" preserveAspectRatio="none" className={`sparkline ${tone}`} aria-hidden="true"><polyline points={spark.map((n, i) => `${i * 7.2},${24 - n * 1.7}`).join(" ")} /></svg></div></div>;
}

function EventRow({ event, detailed = false }: { event: EventItem; detailed?: boolean }) {
  return <div className={`event-row ${detailed ? "event-row-detailed" : ""}`}><div className="event-main"><span className={`event-glyph ${event.status.toLowerCase()}`}>{event.status === "Blocked" ? "⊘" : event.action === "Bash" ? "⌘" : event.action === "Read" ? "⌕" : "✎"}</span><div className="event-copy"><div><strong>{event.action}</strong><span className="event-target">{event.target}</span></div><p>{event.detail}</p>{detailed && <small>{event.id} · {event.source}</small>}</div></div>{detailed && <span className="event-agent">{event.source}</span>}<span className={`status-badge ${event.status.toLowerCase()}`}>{event.status}</span>{detailed && <><span className="event-latency">{event.latency}</span><span className="event-time">{event.time}</span></>}</div>;
}

function Session({ name, project, branch, color, status, time }: { name: string; project: string; branch: string; color: string; status: string; time: string }) { return <div className="session-row"><div className={`agent-avatar ${color}`}>{name === "Claude Code" ? "✳" : "◈"}</div><div className="session-info"><div className="session-title"><strong>{name}</strong><span className={`session-state ${status === "Working" ? "working" : "review"}`}><i />{status}</span></div><span>{project}</span><small><Icon>⑂</Icon>{branch}</small></div><span className="session-time">{time}</span></div>; }

function SessionCard({ name, project, branch, color, status, time }: { name: string; project: string; branch: string; color: string; status: string; time: string }) { return <div className="session-card"><Session name={name} project={`acme / ${project}`} branch={branch} color={color} status={status} time={time} /><div className="session-card-stats"><div><span>TOOL CALLS</span><strong>128</strong></div><div><span>POLICY CHECKS</span><strong>128 <i>all clear</i></strong></div><div><span>TOKEN SPEND</span><strong>$2.41</strong></div></div><button className="text-button" onClick={() => window.alert(`${name} session details are ready for review.`)}>View session details <span>→</span></button></div>; }

function PolicyCard({ icon, name, description, state, tone, count }: { icon: string; name: string; description: string; state: string; tone: string; count: string }) { return <div className="policy-card"><div className={`policy-icon ${tone}`}>{icon}</div><span className={`policy-state ${tone}`}>{state}</span><h3>{name}</h3><p>{description}</p><div className="policy-card-bottom"><span>{count}</span><button aria-label={`Edit ${name}`} onClick={() => window.alert(`${name} policy settings opened.`)}>···</button></div></div>; }

function sectionDescription(tab: Tab) { return ({ activity: "A live, searchable record of every agent tool call and policy decision.", sessions: "Monitor the coding agents working across your projects.", policies: "Shape the boundaries your agents work within.", guide: "Get aligned on the product decisions before your coding agent gets to work.", coach: "Make your prompts clearer before the agent starts spending tokens." } as Record<string, string>)[tab] || "Your AgentDock workspace."; }
