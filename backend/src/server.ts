import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { join, resolve } from "node:path";
import { WebSocketBroadcaster } from "./websocket-server.ts";
import { SupervisorService } from "./supervisor-service.ts";
import { AuditReadError, type AuditReader, type DashboardEvent } from "./audit-reader.ts";
import { parseSearchQuery, parseTimelineQuery } from "./event-query.ts";
import { contentSecurityPolicy, contentType, decodePath, findExportFile } from "./static-files.ts";
import { CodexRoleService } from "./codex-role-service.ts";
import { type CodexRoles, type Project, ProjectRegistry } from "./projects.ts";
import { hasKey, keyStatusCache, type KeyReadOptions } from "./key-reader.ts";
import { applySettingsChange, listModels, readSettingsView, type SettingsDeps } from "./supervisor-settings.ts";
import { isInContainer, resolveSupervisor, supervisorHome, type ResolvedSupervisor } from "./provider-resolver.ts";
import { stdoutLogSink } from "./run-log.ts";
import { ERROR_MESSAGES, SupervisorError, type ProviderName, type RunMode } from "./supervisor-provider.ts";
import { runSupervisor } from "./supervisor-runner.ts";
import type { SupervisorInterviewRequest, WSEventMessage } from "./types.ts";
import type { ReviewResult, SupervisorResult } from "./supervisor-schemas.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 1000;
const TIMELINE_PATH = /^\/api\/sessions\/([^/]+)\/timeline$/;

/** A malformed id gets the same answer as an unknown one. */
function decodeSessionId(raw: string): string | undefined {
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  // eslint-disable-next-line no-control-regex
  return id.length >= 1 && id.length <= 200 && !/[\u0000-\u001f\u007f]/.test(id) ? id : undefined;
}

/** The dashboard refreshes when it sees one of these types. */
function streamType(event: DashboardEvent): WSEventMessage["type"] {
  if (event.hookEventName === "PreToolUse") return "agent_tool_executing";
  if (event.hookEventName === "PostToolUse") return "agent_tool_completed";
  return "agent_session_updated";
}

export interface ServerConfig {
  port?: number;
  host?: string;
  projectPath?: string;
  /** Several projects, in the order the dashboard lists them; overrides `projectPath`. */
  projectPaths?: string[];
  /**
   * Forces Codex on or off, ignoring `supervisor.json` and AGENTDOCK_CODEX, for tests and embedding. Unset, the
   * supervisor comes from `ctrlplane supervisor use` or AGENTDOCK_CODEX=1, read on every run.
   */
  codexEnabled?: boolean;
  /** The folder holding `supervisor.json`. Defaults to CTRLPLANE_HOME or ~/.ctrlplane. */
  supervisorHome?: string;
  /** The environment the supervisor settings are read from. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** How long one supervisor run may take. Defaults to 3 minutes. */
  runTimeoutMs?: number;
  /** Replaces the codex program, for tests: `{ file: process.execPath, prefixArgs: [fakeScript] }`. */
  codexCommand?: { file: string; prefixArgs: string[] };
  /** Receives one JSON line per supervisor run. Defaults to stdout. */
  logSink?: (line: string) => void;
  /** Replaces the OS keychain tool, for tests. */
  keychain?: Omit<KeyReadOptions, "inContainer">;
  /** Replaces the Anthropic API address, for tests. */
  anthropicBaseUrl?: string;
  /** The Next.js export to serve. Defaults to `frontend/out` next to the backend or the working folder. */
  staticRoot?: string;
  /**
   * The Next.js dev server's address (for example http://localhost:3000), allowed to call the API while you work on
   * the dashboard. Off unless AGENTDOCK_DEV_ORIGIN is set; only a localhost or 127.0.0.1 address is accepted.
   */
  devOrigin?: string;
  /** Replaces the Codex runner for every project, for tests. */
  codexRoles?: CodexRoles;
  /** Replaces the Codex runner per project folder, for tests. */
  codexRolesFor?: (projectPath: string) => CodexRoles;
}

/** Only a plain http address on this machine may be named as the dev origin. */
export function parseDevOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const origin = value.toLowerCase();
  return /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/.test(origin) ? origin : undefined;
}

/**
 * Addresses the standalone backend may listen on. Loopback is the default. `0.0.0.0` and `::` exist for a container,
 * where Docker can only forward a port the server listens on for every address; the container's port must then be
 * published to 127.0.0.1 only. A network card's own address is refused, because it would put the dashboard on the network.
 */
const LISTEN_HOSTS = ["127.0.0.1", "::1", "0.0.0.0", "::"];
const LOOPBACK_HOSTS = ["127.0.0.1", "::1"];
const DEFAULT_PORT = 45820;

export type ListenAddress = { host: string; port: number; loopback: boolean } | { error: string };

/** Reads `AGENTDOCK_HOST` and `AGENTDOCK_PORT`. Unset, the backend listens on 127.0.0.1:45820. */
export function parseListenAddress(env: Record<string, string | undefined>): ListenAddress {
  const host = env.AGENTDOCK_HOST || "127.0.0.1";
  if (!LISTEN_HOSTS.includes(host)) {
    return { error: `AGENTDOCK_HOST must be one of ${LISTEN_HOSTS.join(", ")}; got "${host}".` };
  }
  const rawPort = env.AGENTDOCK_PORT || String(DEFAULT_PORT);
  const port = /^\d{1,5}$/.test(rawPort) ? Number(rawPort) : NaN;
  if (!(port >= 1 && port <= 65535)) {
    return { error: `AGENTDOCK_PORT must be a whole number from 1 to 65535; got "${rawPort}".` };
  }
  return { host, port, loopback: LOOPBACK_HOSTS.includes(host) };
}

export class AgentDockBackendServer {
  private server;
  private broadcaster: WebSocketBroadcaster;
  private supervisor: SupervisorService;
  private projects: ProjectRegistry;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private codexEnabledOverride: boolean | undefined;
  private supervisorBusy = false;
  private supervisorHome: string;
  private env: Record<string, string | undefined>;
  private runTimeoutMs: number;
  private logSink: (line: string) => void;
  private keychain: Omit<KeyReadOptions, "inContainer"> | undefined;
  private anthropicBaseUrl: string | undefined;
  private keySaved: (provider: "claude" | "openai-compatible") => Promise<boolean | null>;
  private staticRoots: string[];
  private devOrigin: string | undefined;
  private port: number;
  private host: string;

  constructor(config?: ServerConfig) {
    this.port = config?.port ?? 45820;
    this.host = config?.host ?? "127.0.0.1";
    this.broadcaster = new WebSocketBroadcaster();
    this.supervisor = new SupervisorService();
    const paths = config?.projectPaths?.length ? config.projectPaths : [config?.projectPath ?? process.cwd()];
    const fixedCodex = config?.codexRoles;
    const codexFor =
      config?.codexRolesFor ??
      (fixedCodex
        ? () => fixedCodex
        : (projectPath: string) =>
            new CodexRoleService(projectPath, { command: config?.codexCommand, timeoutMs: config?.runTimeoutMs }));
    this.projects = new ProjectRegistry(paths, codexFor);
    this.codexEnabledOverride = config?.codexEnabled;
    this.env = config?.env ?? process.env;
    this.supervisorHome = supervisorHome(this.env, config?.supervisorHome);
    this.runTimeoutMs = config?.runTimeoutMs ?? 180_000;
    this.logSink = config?.logSink ?? stdoutLogSink;
    this.keychain = config?.keychain;
    this.anthropicBaseUrl = config?.anthropicBaseUrl;
    this.keySaved = keyStatusCache((provider) =>
      hasKey(provider, { ...this.keychain, inContainer: isInContainer(this.env) }),
    );
    this.devOrigin = parseDevOrigin(config?.devOrigin ?? process.env.AGENTDOCK_DEV_ORIGIN);
    this.staticRoots = config?.staticRoot
      ? [config.staticRoot]
      : [
          join(process.cwd(), "frontend", "out"),
          join(process.cwd(), "..", "frontend", "out"),
          join(import.meta.dirname, "..", "..", "frontend", "out"),
        ];

    this.server = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      const knownPath = pathname === "/ws/events" || pathname === "/ws";
      if (knownPath && this.isAllowedHost(req.headers.host) && this.isAllowedBrowserSource(req)) {
        this.broadcaster.handleUpgrade(req, socket);
      } else {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
  }

  public getBroadcaster(): WebSocketBroadcaster {
    return this.broadcaster;
  }

  public getSupervisor(): SupervisorService {
    return this.supervisor;
  }

  public async start(): Promise<{ host: string; port: number }> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        if (typeof addr === "object" && addr !== null) {
          this.port = addr.port;
          this.startPolling();
          resolve({ host: this.host, port: this.port });
        } else {
          reject(new Error("Failed to get backend server address"));
        }
      });

      this.server.on("error", (err) => {
        reject(err);
      });
    });
  }

  public async stop(): Promise<void> {
    clearInterval(this.pollTimer);
    for (const project of this.projects.all()) project.reader.close();
    this.broadcaster.closeAll();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  /** The first project's reader. */
  public getAuditReader(): AuditReader {
    return this.projects.all()[0].reader;
  }

  public getProjects(): ProjectRegistry {
    return this.projects;
  }

  /** Streams every event the daemon has written since the last tick to the connected dashboards. */
  private startPolling(): void {
    this.pollTimer = setInterval(() => this.broadcastNewAuditEvents(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  public broadcastNewAuditEvents(): number {
    let sent = 0;
    for (const project of this.projects.all()) {
      // The reader swallows its own errors, so one unreadable audit log cannot stop the others.
      const fresh = project.reader.poll();
      for (const event of fresh) {
        this.broadcaster.broadcast({
          type: streamType(event),
          sessionId: event.sessionId,
          timestamp: event.timestamp,
          data: { ...event },
          project: project.id,
        });
      }
      sent += fresh.length;
    }
    return sent;
  }

  /** Only this machine's own names, so a DNS name rebound to 127.0.0.1 is refused. */
  private isAllowedHost(host: string | undefined): boolean {
    if (!host) return false;
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host.toLowerCase());
  }

  /** No Origin means a non-browser client (the editor extension, curl). A browser must be on the dashboard itself. */
  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    if (this.devOrigin !== undefined && origin.toLowerCase() === this.devOrigin) return true;
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, `http://[::1]:${this.port}`].includes(
      origin.toLowerCase(),
    );
  }

  /** A cross-site GET (an image, a no-cors fetch) carries no Origin, so only the browser's Sec-Fetch-Site gives it away. */
  private isAllowedBrowserSource(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (this.devOrigin !== undefined && origin?.toLowerCase() === this.devOrigin) return true;
    if (!this.isAllowedOrigin(origin)) return false;
    const site = req.headers["sec-fetch-site"];
    return site !== "cross-site" && site !== "same-site";
  }

  /** A link from another site may open a dashboard page, which only reads static files and cannot be read back. */
  private isPageNavigation(req: IncomingMessage): boolean {
    const pathname = new URL(req.url || "/", "http://localhost").pathname;
    return req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && !pathname.startsWith("/api/");
  }

  public handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // 1. Only this machine and the dashboard's own page may call the API. There are no CORS headers on purpose:
    // without them a browser stops other sites from reading any response.
    if (!this.isAllowedHost(req.headers.host)) {
      this.sendJson(res, 403, { error: "Forbidden host" });
      return;
    }
    // The one exception to "no CORS": the dev server you named, so the page on its own port can read the answers.
    const fromDevServer = this.devOrigin !== undefined && req.headers.origin?.toLowerCase() === this.devOrigin;
    if (fromDevServer) {
      res.setHeader("Access-Control-Allow-Origin", this.devOrigin!);
      res.setHeader("Vary", "Origin");
    }
    if (!this.isAllowedBrowserSource(req) && !this.isPageNavigation(req)) {
      this.sendJson(res, 403, { error: "Forbidden origin" });
      return;
    }
    if (req.method === "OPTIONS") {
      if (!fromDevServer) {
        this.sendJson(res, 403, { error: "Forbidden origin" });
        return;
      }
      res.setHeader("Access-Control-Allow-Methods", "GET, POST");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method === "POST") {
      // A cross-site page can send text/plain without asking first, but not application/json.
      const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (contentType !== "application/json") {
        this.sendJson(res, 415, { error: "Content-Type must be application/json" });
        return;
      }
    }

    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    const pathname = url.pathname;

    // 2. Health check
    if (req.method === "GET" && pathname === "/api/health") {
      void this.supervisorHealth().then((supervisor) =>
        this.sendJson(res, 200, {
          status: "ok",
          service: "AgentDock Backend Platform",
          version: "0.1.0",
          uptimeSeconds: Math.floor(process.uptime()),
          connectedClients: this.broadcaster.getConnectedClientsCount(),
          codexEnabled: supervisor.provider === "codex",
          supervisor,
        }),
      );
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      this.sendJson(res, 200, {
        projects: this.projects.all().map((project) => ({
          id: project.id,
          name: project.name,
          projectPath: project.projectPath,
          available: project.reader.available(),
        })),
      });
      return;
    }

    if (pathname === "/api/supervisor/settings" || pathname === "/api/supervisor/models") {
      this.handleSettings(req, res, pathname, url);
      return;
    }

    // Requests name a project only by an id this backend gave out; a path is never resolved.
    const projectRoutes = [
      "/api/dashboard/state",
      "/api/supervisor/interview",
      "/api/reviewer/explain",
      "/api/events/search",
    ];
    const timelineMatch = TIMELINE_PATH.exec(pathname);
    const project = this.projects.find(url.searchParams.get("project"));
    if ((projectRoutes.includes(pathname) || timelineMatch) && !project) {
      this.sendJson(res, 404, { error: "Unknown project" });
      return;
    }

    if (req.method === "GET" && pathname === "/api/dashboard/state") {
      this.sendJson(res, 200, project!.reader.snapshot());
      return;
    }

    if (req.method === "GET" && pathname === "/api/events/search") {
      const query = parseSearchQuery(url.searchParams);
      if (!query.ok) {
        this.sendJson(res, 400, { error: query.error, code: "QUERY_INVALID" });
        return;
      }
      this.readAudit(res, "search", () => [200, project!.reader.searchEvents(query.value)]);
      return;
    }

    if (req.method === "GET" && timelineMatch) {
      const query = parseTimelineQuery(url.searchParams);
      if (!query.ok) {
        this.sendJson(res, 400, { error: query.error, code: "QUERY_INVALID" });
        return;
      }
      const sessionId = decodeSessionId(timelineMatch[1]);
      this.readAudit(res, "timeline", () => {
        const page = sessionId === undefined ? null : project!.reader.sessionTimeline(sessionId, query.value);
        return page ? [200, page] : [404, { error: "Unknown session for this project.", code: "SESSION_NOT_FOUND" }];
      });
      return;
    }

    // 3. Supervisor Socratic Interview Endpoint
    if (req.method === "POST" && pathname === "/api/supervisor/interview") {
      this.readJsonBody<SupervisorInterviewRequest>(req, res, (body) => {
        if (!body || !body.featurePrompt) {
          this.sendJson(res, 400, { error: "Missing required 'featurePrompt'" });
          return;
        }

        const resolved = this.resolveSupervisor();
        if (resolved.state === "off") {
          this.sendJson(res, 200, this.supervisor.conductInterview(body));
          return;
        }
        const mode: RunMode = body.developerAnswers ? "finalize" : "questions";
        this.runLocked(res, resolved, mode, project!, body, (result) => this.sendJson(res, 200, result));
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/reviewer/explain") {
      const resolved = this.resolveSupervisor();
      if (resolved.state === "off") {
        this.sendJson(res, 503, new SupervisorError("CODEX_OFF").body());
        return;
      }
      this.runLocked(res, resolved, "review", project!, undefined, (result) => this.sendJson(res, 200, result));
      return;
    }

    // 8. Serve Web Dashboard Frontend
    if (req.method === "GET" && !pathname.startsWith("/api/")) {
      this.serveStatic(res, pathname);
      return;
    }

    // Default 404
    this.sendJson(res, 404, { error: "Not Found", path: pathname });
  }

  private serveStatic(res: ServerResponse, pathname: string): void {
    const decoded = decodePath(pathname);
    if (decoded === undefined) {
      this.sendJson(res, 400, { error: "Malformed URL" });
      return;
    }
    const file = findExportFile(this.staticRoots, decoded);
    if (!file) {
      if (decoded === "/" || decoded === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("The dashboard is not built yet. Run npm run build --workspace frontend, then restart the backend.");
        return;
      }
      this.sendJson(res, 404, { error: "Not Found", path: pathname });
      return;
    }
    const type = contentType(file.path);
    const headers: Record<string, string> = { "Content-Type": type, "X-Content-Type-Options": "nosniff" };
    if (type.startsWith("text/html")) {
      headers["Content-Security-Policy"] = contentSecurityPolicy(file.body.toString("utf8"), this.port);
      headers["Referrer-Policy"] = "no-referrer";
      headers["Cache-Control"] = "no-cache";
    }
    res.writeHead(200, headers);
    res.end(file.body);
  }

  /**
   * `ready` means a click would start a model call. The key answer is cached for 30 seconds because the dashboard
   * asks on every streamed event; a run never uses the cache.
   */
  private async supervisorHealth(): Promise<{
    provider: ProviderName | null;
    model: string | null;
    keySaved: boolean | null;
    ready: boolean;
  }> {
    const resolved = this.resolveSupervisor();
    if (resolved.state !== "on") return { provider: null, model: null, keySaved: null, ready: false };
    const { provider, model } = resolved;
    if (provider === "codex") return { provider, model, keySaved: null, ready: true };
    const keySaved = await this.keySaved(provider);
    const ready = !isInContainer(this.env) && (provider === "openai-compatible" || keySaved === true);
    return { provider, model, keySaved, ready };
  }

  private settingsDeps(): SettingsDeps {
    return {
      home: this.supervisorHome,
      env: this.env,
      keychain: this.keychain,
      anthropicBaseUrl: this.anthropicBaseUrl,
      timeoutMs: this.runTimeoutMs,
      codexEnabledOverride: this.codexEnabledOverride,
    };
  }

  /** User-scope routes, so no `?project=`. Every request already passed the Origin check, and POST the Content-Type check, above. */
  private handleSettings(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL): void {
    const reply = (work: Promise<{ status: number; body: unknown }>) =>
      void work
        .then(({ status, body }) => this.sendJson(res, status, body))
        .catch(() => {
          if (!res.headersSent) this.sendJson(res, 500, { error: "Internal error" });
        });
    if (req.method === "GET" && pathname === "/api/supervisor/settings") {
      reply(readSettingsView(this.settingsDeps()).then((body) => ({ status: 200, body })));
    } else if (req.method === "POST" && pathname === "/api/supervisor/settings") {
      this.readJsonBody<unknown>(req, res, (body) => reply(applySettingsChange(body, this.settingsDeps())));
    } else if (req.method === "GET" && pathname === "/api/supervisor/models") {
      reply(listModels(url.searchParams.get("provider"), this.settingsDeps()));
    } else {
      this.sendJson(res, 404, { error: "Not Found", path: pathname });
    }
  }

  /** Read on every request, so `ctrlplane supervisor use` applies without a restart. */
  private resolveSupervisor(): ResolvedSupervisor {
    return resolveSupervisor({
      home: this.supervisorHome,
      env: this.env,
      codexEnabledOverride: this.codexEnabledOverride,
    });
  }

  /**
   * One supervisor run at a time across every provider and project: each one is a model session that costs money and
   * can take minutes. A failure reaches the browser only as its fixed message and code.
   */
  private runLocked(
    res: ServerResponse,
    resolved: Exclude<ResolvedSupervisor, { state: "off" }>,
    mode: RunMode,
    project: Project,
    body: SupervisorInterviewRequest | undefined,
    done: (result: SupervisorResult | ReviewResult) => void,
  ): void {
    if (this.supervisorBusy) {
      this.sendJson(res, 409, { error: ERROR_MESSAGES.BUSY({}), code: "BUSY" });
      return;
    }
    this.supervisorBusy = true;
    runSupervisor({
      mode,
      project,
      resolved,
      body,
      deps: {
        timeoutMs: this.runTimeoutMs,
        logSink: this.logSink,
        env: this.env,
        keychain: this.keychain,
        anthropicBaseUrl: this.anthropicBaseUrl,
      },
    })
      .then(done)
      .catch((error: unknown) => {
        const failure = error instanceof SupervisorError ? error : new SupervisorError("PROVIDER_ERROR");
        this.sendJson(res, 503, failure.body());
      })
      .finally(() => {
        this.supervisorBusy = false;
      });
  }

  /**
   * Answers a live-view read. A database that cannot be read gives 503 and one log line with the route and the
   * SQLite error code: never SQL text, the error message or the search text.
   */
  private readAudit(res: ServerResponse, route: string, read: () => [number, unknown]): void {
    try {
      const [status, body] = read();
      this.sendJson(res, status, body);
    } catch (err) {
      const code = err instanceof AuditReadError ? err.code : "unknown";
      console.error(`AgentDock Backend: ${route} read failed, code=${code}`);
      this.sendJson(res, 503, { error: "The audit database could not be read. Try again.", code: "DB_UNAVAILABLE" });
    }
  }

  private sendJson(res: ServerResponse, statusCode: number, data: unknown): void {
    res.writeHead(statusCode, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  /**
   * Collects the raw bytes and decodes once, so a character split across two chunks survives.
   * Answers 413 / 400 / 500 itself and calls `callback` at most once.
   */
  private readJsonBody<T>(req: IncomingMessage, res: ServerResponse, callback: (parsed: T | null) => void): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let finished = false;
    const fail = (status: number, error: string) => {
      if (finished) return;
      finished = true;
      if (!res.headersSent) this.sendJson(res, status, { error });
    };

    req.on("data", (chunk: Buffer) => {
      if (finished) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        fail(413, `Request body is larger than ${MAX_BODY_BYTES} bytes`);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (finished) return;
      let parsed: T | null;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
      } catch {
        fail(400, "Invalid JSON body");
        return;
      }
      finished = true;
      try {
        callback(parsed);
      } catch {
        if (!res.headersSent) this.sendJson(res, 500, { error: "Internal error" });
      }
    });
    req.on("error", () => fail(400, "Could not read request body"));
  }
}

// Standalone runner if executed directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const named = process.argv.flatMap((arg, i) =>
    arg === "--project" && process.argv[i + 1] ? [process.argv[i + 1]] : [],
  );
  const projectPaths = (named.length ? named : [process.env.AGENTDOCK_PROJECT ?? "."]).map((p) => resolve(p));
  const listen = parseListenAddress(process.env);
  if ("error" in listen) {
    console.error(`AgentDock Backend did not start: ${listen.error}`);
    process.exitCode = 1;
  } else {
    const server = new AgentDockBackendServer({ host: listen.host, port: listen.port, projectPaths });
    server
      .start()
      .then(({ port }) => {
        // On 0.0.0.0 or :: the address to open is still this machine's: the Host check accepts nothing else.
        const shown = listen.host === "::1" ? "[::1]" : "127.0.0.1";
        console.log(`AgentDock Backend running at http://${shown}:${port}`);
        if (!listen.loopback) {
          console.log(
            `Listening on every address (${listen.host}) for a container. Publish the port to 127.0.0.1 only, ` +
              `for example -p 127.0.0.1:${port}:${port}; anything else puts the audit log on the network.`,
          );
        }
        for (const project of server.getProjects().all()) {
          console.log(
            `Reading the audit log of ${project.projectPath} (${project.reader.databasePath}) as "${project.id}"`,
          );
        }
        console.log(`WebSocket event stream ready at ws://${shown}:${port}/ws/events`);
      })
      .catch((err: unknown) => {
        console.error(`AgentDock Backend failed to start: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      });
  }
}
