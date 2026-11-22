"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  type DashboardSnapshot,
  type Page,
  type ProjectSummary,
  approvalRequests,
  auditReadProblem,
  isForProject,
  pageFromHash,
  projectFromSearch,
  projectName,
  projectQuery,
} from "../lib/events";
import Overview, { WarnIcon } from "./overview";
import PlanReview from "./plan-review";
import Project, { type Health } from "./project";
import Rules from "./rules";
import Sessions from "./sessions";
import Settings from "./settings";
import Waiting from "./waiting";

const EMPTY: DashboardSnapshot = {
  events: [],
  sessions: [],
  counts: {
    toolCalls: 0,
    blockedCalls: 0,
    reviewCalls: 0,
    activeSessions: 0,
    totalEvents: 0,
    usage: null,
    usageRecorded: true,
  },
  approvals: { windowMs: 0, events: [] },
};
const API_ORIGIN =
  process.env.NEXT_PUBLIC_BACKEND_API_ORIGIN ||
  (process.env.NODE_ENV === "development" ? "http://127.0.0.1:45820" : "");
const NAV_GROUPS = ["Monitor", "Govern", "Supervisor", "Setup"] as const;
const NAV: { id: Page; label: string; group: (typeof NAV_GROUPS)[number] }[] = [
  { id: "overview", label: "Overview", group: "Monitor" },
  { id: "waiting", label: "Waiting on you", group: "Monitor" },
  { id: "sessions", label: "Sessions", group: "Monitor" },
  { id: "rules", label: "Rules", group: "Govern" },
  { id: "plan", label: "Plan & review", group: "Supervisor" },
  { id: "project", label: "Project", group: "Setup" },
  { id: "settings", label: "Settings", group: "Setup" },
];

const ICONS: Record<Page, ReactNode> = {
  overview: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </>
  ),
  waiting: (
    <>
      <circle cx="12" cy="12" r="9" />
      <polyline points="12 7 12 12 15 14" />
    </>
  ),
  sessions: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <polyline points="6 9 9 12 6 15" />
      <line x1="12" y1="15" x2="17" y2="15" />
    </>
  ),
  rules: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  plan: (
    <>
      <polyline points="9 11 12 14 20 6" />
      <path d="M20 12v6a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h9" />
    </>
  ),
  project: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  settings: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="9" cy="7" r="2.5" fill="var(--side)" />
      <circle cx="15" cy="17" r="2.5" fill="var(--side)" />
    </>
  ),
};

function NavIcon({ page }: { page: Page }) {
  return (
    <svg
      aria-hidden="true"
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {ICONS[page]}
    </svg>
  );
}

export default function Dashboard() {
  const [page, setPage] = useState<Page>("overview");
  const [snapshot, setSnapshot] = useState(EMPTY);
  const [readProblem, setReadProblem] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [connected, setConnected] = useState(false);
  const [backendReachable, setBackendReachable] = useState(false);
  const [checked, setChecked] = useState(false);
  const [toast, setToast] = useState("");
  const [mobileOpen, setMobileOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const pickedRef = useRef<string | null>(null);
  const shownRef = useRef<string | null>(null);
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  pickedRef.current = pickedId;
  const shownId = pickedId ?? projects[0]?.id ?? null;
  shownRef.current = shownId;

  // The picked project lives in ?project=, so reload and Back keep it.
  useEffect(() => {
    const sync = () => setPickedId(projectFromSearch(window.location.search));
    sync();
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    void refreshRef.current();
  }, [pickedId]);

  // The page lives in the address hash, so reload and Back keep the developer where they were.
  useEffect(() => {
    const sync = () => {
      setPage(pageFromHash(window.location.hash));
      setMobileOpen(false);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 10_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout>;
    let disposed = false;
    const refresh = async (): Promise<void> => {
      const picked = pickedRef.current;
      try {
        const response = await fetch(`${API_ORIGIN}/api/dashboard/state${projectQuery(picked)}`, { cache: "no-store" });
        if (response.status === 404 && picked) {
          // A bookmark to a project this backend no longer watches opens the first one.
          window.history.replaceState(null, "", window.location.pathname + window.location.hash);
          pickedRef.current = null;
          setPickedId(null);
          return;
        }
        // The log exists but cannot be read: say why rather than show empty lists that look like nothing needs you.
        const problem = response.status === 503 ? auditReadProblem(503, await response.json().catch(() => null)) : null;
        if (!response.ok && problem === null) throw new Error("Dashboard API unavailable");
        const state = problem === null ? ((await response.json()) as DashboardSnapshot) : null;
        const status = await fetch(`${API_ORIGIN}/api/health`, { cache: "no-store" })
          .then((r) => r.json() as Promise<Health>)
          .catch(() => null);
        const list = await fetch(`${API_ORIGIN}/api/projects`, { cache: "no-store" })
          .then((r) => (r.ok ? (r.json() as Promise<{ projects: ProjectSummary[] }>) : { projects: [] }))
          .catch(() => ({ projects: [] }));
        // An answer for a project the developer has since switched away from is dropped.
        if (!disposed && pickedRef.current === picked) {
          setProjects(list.projects);
          if (state) setSnapshot(state);
          setReadProblem(problem);
          setHealth(status);
          setBackendReachable(true);
          setNow(Date.now());
        }
      } catch {
        if (!disposed) setBackendReachable(false);
      } finally {
        if (!disposed) setChecked(true);
      }
    };
    const connect = () => {
      if (disposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const host =
        process.env.NEXT_PUBLIC_BACKEND_WS_HOST ||
        (process.env.NODE_ENV === "development" ? "127.0.0.1:45820" : window.location.host);
      try {
        socket = new WebSocket(`${protocol}//${host}/ws/events`);
        socket.onopen = () => {
          if (!disposed) {
            setConnected(true);
            void refresh();
          }
        };
        socket.onmessage = (message) => {
          try {
            const event = JSON.parse(message.data);
            if (
              ["agent_tool_executing", "agent_tool_completed", "agent_session_updated"].includes(event.type) &&
              isForProject(event, shownRef.current)
            )
              void refresh();
          } catch {
            /* Ignore malformed telemetry frames. */
          }
        };
        socket.onclose = () => {
          if (!disposed) {
            setConnected(false);
            // A closed socket usually means the backend stopped; the failed fetch is what shows the offline banner.
            void refresh();
            retry = setTimeout(connect, 2000);
          }
        };
        socket.onerror = () => socket?.close();
      } catch {
        if (!disposed) retry = setTimeout(connect, 2000);
      }
    };
    refreshRef.current = refresh;
    void refresh();
    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(""), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  function copy(text: string, label: string) {
    void navigator.clipboard
      .writeText(text)
      .then(() => setToast(`${label} copied.`))
      .catch(() => setToast("Clipboard access is unavailable."));
  }

  function pickProject(id: string) {
    const url = new URL(window.location.href);
    url.searchParams.set("project", id);
    window.history.pushState(null, "", url);
    setSnapshot(EMPTY);
    setReadProblem(null);
    setPickedId(id);
  }

  const open = approvalRequests(snapshot, now).open;
  const shownProject = projects.find((project) => project.id === shownId) ?? null;

  return (
    <div className="ad-shell">
      <nav className={`ad-side ${mobileOpen ? "ad-side-open" : ""}`} aria-label="Main">
        <div className="ad-brand">
          <div className="ad-logo" aria-hidden="true">
            AD
          </div>
          <div className="ad-brand-text">
            <strong>AgentDock</strong>
            <small title={snapshot.source?.projectPath}>
              {projects.length > 1 ? `${projects.length} projects` : projectName(snapshot.source?.projectPath)}
            </small>
          </div>
          <button
            type="button"
            className="ad-menu-btn"
            aria-expanded={mobileOpen}
            aria-controls="ad-menu"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileOpen(!mobileOpen)}
          >
            <svg
              aria-hidden="true"
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <line x1="4" y1="6" x2="20" y2="6" />
              <line x1="4" y1="12" x2="20" y2="12" />
              <line x1="4" y1="18" x2="20" y2="18" />
            </svg>
          </button>
        </div>
        <div className="ad-menu" id="ad-menu">
          {projects.length > 1 && (
            <div className="ad-project">
              <label htmlFor="ad-project">Project</label>
              <select id="ad-project" value={shownId ?? ""} onChange={(event) => pickProject(event.target.value)}>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.available ? project.name : `${project.name} (no audit log)`}
                  </option>
                ))}
              </select>
            </div>
          )}
          {NAV_GROUPS.map((group) => (
            <div className="ad-group" key={group}>
              <span className="ad-group-h">{group}</span>
              {NAV.filter((item) => item.group === group).map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="ad-nav"
                  aria-current={page === item.id ? "page" : undefined}
                  onClick={() => setMobileOpen(false)}
                >
                  <NavIcon page={item.id} />
                  {item.label}
                  {item.id === "waiting" && open > 0 && (
                    <span className="ad-badge">
                      {open}
                      <span className="sr-only"> with no record {open === 1 ? "it" : "they"} ran</span>
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
          <div className="ad-side-foot">
            <span className="ad-health">
              <span className={`ad-hdot ${backendReachable ? "" : "ad-hdot-off"}`} aria-hidden="true" />
              {backendReachable ? "Backend reachable" : checked ? "Backend not reachable" : "Checking backend"}
            </span>
            <span>{snapshot.counts.totalEvents.toLocaleString()} events stored locally</span>
          </div>
        </div>
      </nav>

      <main className="ad-main">
        <div className="content-wrap">
          {checked && !backendReachable && (
            <div className="ov-banner" role="alert">
              <WarnIcon />
              <span>
                Can&apos;t reach the AgentDock backend. Showing the last data loaded and retrying on its own. Your
                agents are still supervised: rules run in the CLI, not in this page.
              </span>
            </div>
          )}
          {backendReachable && readProblem && (
            <div className="panel notice-panel" role="alert">
              <strong>Can&apos;t read the audit log: {readProblem}</strong>
              <p>
                The backend reads <code>{snapshot.source?.databasePath ?? ".ctrlplane/audit.db"}</code> and retries on
                its own. Your agents are still supervised: rules run in the CLI, not in this page.
              </p>
            </div>
          )}
          {backendReachable && !readProblem && snapshot.source && !snapshot.source.available && page !== "project" && (
            <div className="panel notice-panel" role="status">
              <strong>No audit log found</strong>
              <p>
                The backend reads <code>{snapshot.source.databasePath}</code>. Run <code>ctrlplane init</code> and{" "}
                <code>ctrlplane start</code> in that project, or restart the backend with{" "}
                <code>--project &lt;path&gt;</code>.
              </p>
            </div>
          )}
          {page === "overview" && !readProblem && (
            <Overview
              snapshot={snapshot}
              connected={connected}
              backendReachable={backendReachable}
              checked={checked}
              onCopy={copy}
            />
          )}
          {page === "waiting" && !readProblem && <Waiting snapshot={snapshot} now={now} />}
          {page === "sessions" && !readProblem && (
            <Sessions snapshot={snapshot} now={now} apiOrigin={API_ORIGIN} projectId={shownId} />
          )}
          {page === "rules" && !readProblem && <Rules snapshot={snapshot} onCopy={copy} />}
          {/* Stays mounted so a running plan or Codex explanation keeps its answer across page switches. */}
          <div hidden={page !== "plan"}>
            <PlanReview
              apiOrigin={API_ORIGIN}
              supervisor={health?.supervisor ?? null}
              project={shownProject}
              showProject={projects.length > 1}
              onCopy={copy}
              onToast={setToast}
            />
          </div>
          {page === "project" && (
            <Project
              snapshot={snapshot}
              health={health}
              connected={connected}
              backendReachable={backendReachable}
              onCopy={copy}
            />
          )}
          {page === "settings" && <Settings apiOrigin={API_ORIGIN} onCopy={copy} onToast={setToast} />}
        </div>
      </main>
      {toast && (
        <div role="status" className="toast">
          <span>✓</span>
          {toast}
        </div>
      )}
    </div>
  );
}
