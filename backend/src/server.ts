import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import { WebSocketBroadcaster } from "./websocket-server.ts";
import { SupervisorService } from "./supervisor-service.ts";
import { evaluatePromptQuality } from "./prompt-coach.ts";
import { calculateTurnCost } from "./token-pricing.ts";
import { AuditReader, type DashboardEvent } from "./audit-reader.ts";
import { CodexRoleService } from "./codex-role-service.ts";
import type { SupervisorInterviewRequest, TrajectoryLoopCheckRequest, WSEventMessage } from "./types.ts";

const MAX_BODY_BYTES = 1024 * 1024;
const POLL_INTERVAL_MS = 1000;

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
  /** Lets the guide and the explainer run Codex CLI. Off unless AGENTDOCK_CODEX=1, because each run calls a paid model. */
  codexEnabled?: boolean;
  /** Replaces the Codex runner, for tests. */
  codexRoles?: Pick<CodexRoleService, "interview" | "review">;
}

const CODEX_OFF =
  "The code explainer runs Codex CLI, which is turned off. Restart the backend with AGENTDOCK_CODEX=1 to turn it on.";

export class AgentDockBackendServer {
  private server;
  private broadcaster: WebSocketBroadcaster;
  private supervisor: SupervisorService;
  private audit: AuditReader;
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private codexRoles: Pick<CodexRoleService, "interview" | "review">;
  private codexEnabled: boolean;
  private codexBusy = false;
  private port: number;
  private host: string;

  constructor(config?: ServerConfig) {
    this.port = config?.port ?? 45820;
    this.host = config?.host ?? "127.0.0.1";
    this.broadcaster = new WebSocketBroadcaster();
    this.supervisor = new SupervisorService();
    const projectPath = config?.projectPath ?? process.cwd();
    this.audit = new AuditReader(projectPath);
    this.codexRoles = config?.codexRoles ?? new CodexRoleService(projectPath);
    this.codexEnabled = config?.codexEnabled ?? process.env.AGENTDOCK_CODEX === "1";

    this.server = createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    this.server.on("upgrade", (req: IncomingMessage, socket: Socket) => {
      const pathname = new URL(req.url || "/", "http://localhost").pathname;
      const knownPath = pathname === "/ws/events" || pathname === "/ws";
      if (knownPath && this.isAllowedHost(req.headers.host) && this.isAllowedOrigin(req.headers.origin)) {
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
    this.audit.close();
    this.broadcaster.closeAll();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  public getAuditReader(): AuditReader {
    return this.audit;
  }

  /** Streams every event the daemon has written since the last tick to the connected dashboards. */
  private startPolling(): void {
    this.pollTimer = setInterval(() => this.broadcastNewAuditEvents(), POLL_INTERVAL_MS);
    this.pollTimer.unref();
  }

  public broadcastNewAuditEvents(): number {
    const fresh = this.audit.poll();
    for (const event of fresh) {
      this.broadcaster.broadcast({ type: streamType(event), sessionId: event.sessionId, timestamp: event.timestamp, data: { ...event } });
    }
    return fresh.length;
  }

  /** Only this machine's own names, so a DNS name rebound to 127.0.0.1 is refused. */
  private isAllowedHost(host: string | undefined): boolean {
    if (!host) return false;
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`].includes(host.toLowerCase());
  }

  /** No Origin means a non-browser client (the editor extension, curl). A browser must be on the dashboard itself. */
  private isAllowedOrigin(origin: string | undefined): boolean {
    if (origin === undefined) return true;
    return [`http://127.0.0.1:${this.port}`, `http://localhost:${this.port}`, `http://[::1]:${this.port}`].includes(
      origin.toLowerCase(),
    );
  }

  public handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // 1. Only this machine and the dashboard's own page may call the API. There are no CORS headers on purpose:
    // without them a browser stops other sites from reading any response.
    if (!this.isAllowedHost(req.headers.host)) {
      this.sendJson(res, 403, { error: "Forbidden host" });
      return;
    }
    if (req.method === "POST") {
      if (!this.isAllowedOrigin(req.headers.origin)) {
        this.sendJson(res, 403, { error: "Forbidden origin" });
        return;
      }
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
      this.sendJson(res, 200, {
        status: "ok",
        service: "AgentDock Backend Platform",
        version: "0.1.0",
        uptimeSeconds: Math.floor(process.uptime()),
        connectedClients: this.broadcaster.getConnectedClientsCount(),
        codexEnabled: this.codexEnabled,
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/dashboard/state") {
      this.sendJson(res, 200, this.audit.snapshot());
      return;
    }

    // 3. Supervisor Socratic Interview Endpoint
    if (req.method === "POST" && pathname === "/api/supervisor/interview") {
      this.readJsonBody<SupervisorInterviewRequest>(req, res, (body) => {
        if (!body || !body.featurePrompt) {
          this.sendJson(res, 400, { error: "Missing required 'featurePrompt'" });
          return;
        }

        const announce = (result: { isRefined: boolean; lockedSpecification?: { title: string; specHash: string; acceptanceCriteria: string[] } }) => {
          if (result.isRefined && result.lockedSpecification) {
            this.broadcaster.broadcast({
              type: "spec_updated",
              sessionId: "active_session",
              timestamp: Date.now(),
              data: {
                title: result.lockedSpecification.title,
                specHash: result.lockedSpecification.specHash,
                criteriaCount: result.lockedSpecification.acceptanceCriteria.length,
              },
            });
          }
          this.sendJson(res, 200, result);
        };
        if (!this.codexEnabled) {
          announce(this.supervisor.conductInterview(body));
          return;
        }
        this.runCodex(res, () => this.codexRoles.interview(body.featurePrompt, body.developerAnswers), announce);
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/reviewer/explain") {
      if (!this.codexEnabled) {
        this.sendJson(res, 503, { error: CODEX_OFF });
        return;
      }
      this.runCodex(res, () => this.codexRoles.review(), (result) => this.sendJson(res, 200, result));
      return;
    }

    // 4. Trajectory Loop Check Endpoint
    if (req.method === "POST" && pathname === "/api/supervisor/loop-check") {
      this.readJsonBody<TrajectoryLoopCheckRequest>(req, res, (body) => {
        if (!body || !Array.isArray(body.recentTools)) {
          this.sendJson(res, 400, { error: "Missing required 'recentTools' array" });
          return;
        }

        const loopResult = this.supervisor.checkTrajectoryForLoops(body);

        // If loop detected, broadcast alert
        if (loopResult.loopDetected) {
          this.broadcaster.broadcast({
            type: "circuit_breaker_alert",
            sessionId: body.sessionId || "unknown",
            timestamp: Date.now(),
            data: {
              consecutiveFailures: loopResult.consecutiveFailureCount,
              message: loopResult.message,
            },
          });
        }

        this.sendJson(res, 200, loopResult);
      });
      return;
    }

    // 5. Ingest and Broadcast Telemetry Event
    if (req.method === "POST" && pathname === "/api/events/broadcast") {
      this.readJsonBody<WSEventMessage>(req, res, (event) => {
        if (!event || !event.type) {
          this.sendJson(res, 400, { error: "Invalid event payload" });
          return;
        }

        this.broadcaster.broadcast(event);
        this.sendJson(res, 200, { success: true, broadcastedTo: this.broadcaster.getConnectedClientsCount() });
      });
      return;
    }

    // 6. Prompt Coach Endpoint
    if (req.method === "POST" && pathname === "/api/coach/analyze") {
      this.readJsonBody<{ prompt?: string }>(req, res, (body) => {
        const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
        if (!prompt) {
          this.sendJson(res, 400, { error: "Missing required 'prompt'" });
          return;
        }
        this.sendJson(res, 200, evaluatePromptQuality(prompt));
      });
      return;
    }

    // 7. Token Cost Calculator Endpoint
    if (req.method === "POST" && pathname === "/api/cost/calculate") {
      this.readJsonBody<{ modelName?: string; inputTokens?: number; outputTokens?: number }>(req, res, (body) => {
        this.sendJson(
          res,
          200,
          calculateTurnCost({
            modelName: body?.modelName,
            inputTokens: body?.inputTokens,
            outputTokens: body?.outputTokens,
          }),
        );
      });
      return;
    }

    // 8. Serve Web Dashboard Frontend
    if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || !pathname.startsWith("/api/"))) {
      const exportRoots = [
        join(process.cwd(), "frontend", "out"),
        join(process.cwd(), "..", "frontend", "out"),
        join(import.meta.dirname, "..", "..", "frontend", "out"),
      ];
      const decodedPath = decodeURIComponent(pathname);
      for (const root of exportRoots) {
        const candidate = resolve(root, `.${decodedPath}`);
        const fromRoot = relative(resolve(root), candidate);
        if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) continue;
        const fileCandidates = [candidate, join(candidate, "index.html")];
        const file = fileCandidates.find((path) => existsSync(path) && statSync(path).isFile());
        if (!file) continue;
        const types: Record<string, string> = {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".json": "application/json; charset=utf-8",
          ".svg": "image/svg+xml",
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".webp": "image/webp",
          ".ico": "image/x-icon",
          ".woff": "font/woff",
          ".woff2": "font/woff2",
        };
        res.writeHead(200, { "Content-Type": types[extname(file)] ?? "application/octet-stream" });
        res.end(readFileSync(file));
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
        res.end("Next.js frontend export is missing. Run npm run build --workspace frontend, then restart the backend.");
        return;
      }
    }

    // Default 404
    this.sendJson(res, 404, { error: "Not Found", path: pathname });
  }

  /** One Codex run at a time: each one is a model session that costs money and can take minutes. */
  private runCodex<T>(res: ServerResponse, run: () => Promise<T>, done: (result: T) => void): void {
    if (this.codexBusy) {
      this.sendJson(res, 409, { error: "A Codex run is already in progress. Wait for it to finish." });
      return;
    }
    this.codexBusy = true;
    run()
      .then(done)
      .catch((error: unknown) => this.sendJson(res, 503, { error: error instanceof Error ? error.message : String(error) }))
      .finally(() => {
        this.codexBusy = false;
      });
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
  const flag = process.argv.indexOf("--project");
  const projectPath = resolve(flag > -1 && process.argv[flag + 1] ? process.argv[flag + 1] : (process.env.AGENTDOCK_PROJECT ?? "."));
  const server = new AgentDockBackendServer({ port: 45820, projectPath });
  server
    .start()
    .then(({ host, port }) => {
      console.log(`AgentDock Backend running at http://${host}:${port}`);
      console.log(`Reading the audit log of ${projectPath} (${server.getAuditReader().databasePath})`);
      console.log(`WebSocket event stream ready at ws://${host}:${port}/ws/events`);
    })
    .catch((err: unknown) => {
      console.error(`AgentDock Backend failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}
