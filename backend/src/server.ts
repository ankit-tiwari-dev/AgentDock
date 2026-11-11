import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketBroadcaster } from "./websocket-server.ts";
import { SupervisorService } from "./supervisor-service.ts";
import { evaluatePromptQuality } from "./prompt-coach.ts";
import { calculateTurnCost } from "./token-pricing.ts";
import type {
  SupervisorInterviewRequest,
  TrajectoryLoopCheckRequest,
  WSEventMessage,
} from "./types.ts";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ServerConfig {
  port?: number;
  host?: string;
  projectPath?: string;
}

export class AgentDockBackendServer {
  private server;
  private broadcaster: WebSocketBroadcaster;
  private supervisor: SupervisorService;
  private port: number;
  private host: string;

  constructor(config?: ServerConfig) {
    this.port = config?.port ?? 45820;
    this.host = config?.host ?? "127.0.0.1";
    this.broadcaster = new WebSocketBroadcaster();
    this.supervisor = new SupervisorService();

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
    this.broadcaster.closeAll();
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
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

        const interviewResult = this.supervisor.conductInterview(body);

        // Broadcast spec lock event if refined
        if (interviewResult.isRefined && interviewResult.lockedSpecification) {
          this.broadcaster.broadcast({
            type: "spec_updated",
            sessionId: "active_session",
            timestamp: Date.now(),
            data: {
              title: interviewResult.lockedSpecification.title,
              specHash: interviewResult.lockedSpecification.specHash,
              criteriaCount: interviewResult.lockedSpecification.acceptanceCriteria.length,
            },
          });
        }

        this.sendJson(res, 200, interviewResult);
      });
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
      const candidates = [
        join(process.cwd(), "frontend", "public", "index.html"),
        join(process.cwd(), "..", "frontend", "public", "index.html"),
        join(import.meta.dirname, "..", "..", "frontend", "public", "index.html"),
      ];
      const resolved = candidates.find((p) => existsSync(p));

      if (resolved) {
        const html = readFileSync(resolved, "utf8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
        return;
      }
    }

    // Default 404
    this.sendJson(res, 404, { error: "Not Found", path: pathname });
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
  const server = new AgentDockBackendServer({ port: 45820 });
  server
    .start()
    .then(({ host, port }) => {
      console.log(`AgentDock Backend running at http://${host}:${port}`);
      console.log(`WebSocket event stream ready at ws://${host}:${port}/ws/events`);
    })
    .catch((err: unknown) => {
      console.error(`AgentDock Backend failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    });
}

