import { createServer, IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocketBroadcaster } from "./websocket-server.ts";
import { SupervisorService } from "./supervisor-service.ts";
import type {
  SupervisorInterviewRequest,
  TrajectoryLoopCheckRequest,
  WSEventMessage,
} from "./types.ts";

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
      if (req.url === "/ws/events" || req.url === "/ws") {
        this.broadcaster.handleUpgrade(req, socket);
      } else {
        socket.destroy();
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
    return new Promise((resolve) => {
      this.server.close(() => resolve());
    });
  }

  private handleHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    // 1. CORS headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
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
      this.readJsonBody<SupervisorInterviewRequest>(req, (body) => {
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
      this.readJsonBody<TrajectoryLoopCheckRequest>(req, (body) => {
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
      this.readJsonBody<WSEventMessage>(req, (event) => {
        if (!event || !event.type) {
          this.sendJson(res, 400, { error: "Invalid event payload" });
          return;
        }

        this.broadcaster.broadcast(event);
        this.sendJson(res, 200, { success: true, broadcastedTo: this.broadcaster.getConnectedClientsCount() });
      });
      return;
    }

    // 6. Serve Web Dashboard Frontend
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

  private readJsonBody<T>(req: IncomingMessage, callback: (parsed: T | null) => void): void {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body) as T;
        callback(parsed);
      } catch {
        callback(null);
      }
    });
    req.on("error", () => {
      callback(null);
    });
  }
}

// Standalone runner if executed directly
if (process.argv[1]?.endsWith("server.ts") || process.argv[1]?.endsWith("server.js")) {
  const server = new AgentDockBackendServer({ port: 45820 });
  server.start().then(({ host, port }) => {
    console.log(`AgentDock Backend running at http://${host}:${port}`);
    console.log(`WebSocket event stream ready at ws://${host}:${port}/ws/events`);
  });
}

