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

    // 6. Prompt Coach Endpoint (adapted from aGiTrack)
    if (req.method === "POST" && pathname === "/api/coach/analyze") {
      this.readJsonBody<{ prompt?: string }>(req, (body) => {
        const prompt = body?.prompt?.trim() || "";
        if (!prompt) {
          this.sendJson(res, 400, { error: "Missing required 'prompt'" });
          return;
        }

        const lower = prompt.toLowerCase();
        const issues: string[] = [];
        const recommendations: string[] = [];
        let score = 85;

        if (prompt.length < 15) {
          issues.push("Prompt is too brief (< 15 characters). Coding agents often guess blindly.");
          recommendations.push("Specify the exact file, expected output, and target behavior.");
          score -= 40;
        } else if (prompt.length < 40 && !lower.includes(".")) {
          issues.push("Prompt lacks file references or error detail.");
          recommendations.push("Include target file paths (e.g. `src/auth.ts`) or exact error text.");
          score -= 20;
        }

        if (lower.includes("still failing") || lower.includes("you broke") || lower.includes("same mistake")) {
          issues.push("Frustration phrasing detected. Coding agents cannot self-correct without diagnostic logs.");
          recommendations.push("Paste the exact terminal error output or stack trace rather than saying 'it failed'.");
          score -= 25;
        }

        const taskSeparators = lower.split(/and also|in addition|furthermore|, and /);
        if (taskSeparators.length >= 4) {
          issues.push("Multi-task overload: Prompt combines 4+ distinct tasks in a single turn.");
          recommendations.push("Split into sequential turns: let the agent complete and test task 1 before assigning task 2.");
          score -= 20;
        }

        const mentionsTests = lower.includes("test") || lower.includes("spec") || lower.includes("verify") || lower.includes("assert");
        if (!mentionsTests && prompt.length > 50) {
          recommendations.push("Tip: Add an acceptance test instruction: 'Run test suite to verify zero regressions.'");
          score -= 5;
        }

        score = Math.max(10, Math.min(100, score));
        let rating = "EXCELLENT";
        if (score < 50) rating = "HIGH_RISK";
        else if (score < 70) rating = "NEEDS_IMPROVEMENT";
        else if (score < 85) rating = "GOOD";

        const suggestedPrompt = (rating === "HIGH_RISK" || rating === "NEEDS_IMPROVEMENT")
          ? `Objective: ${prompt}\nTarget Files: [specify path]\nAcceptance Criteria:\n1. [Expected outcome]\n2. Run tests to confirm zero regressions.`
          : prompt;

        this.sendJson(res, 200, {
          prompt,
          score,
          rating,
          detectedIssues: issues,
          recommendations,
          suggestedPrompt,
        });
      });
      return;
    }

    // 7. Token Cost Calculator Endpoint (adapted from Builderz Labs Mission Control)
    if (req.method === "POST" && pathname === "/api/cost/calculate") {
      this.readJsonBody<{ modelName?: string; inputTokens?: number; outputTokens?: number }>(req, (body) => {
        const model = body?.modelName || "claude-3-5-sonnet";
        const inputTokens = Math.max(0, body?.inputTokens || 0);
        const outputTokens = Math.max(0, body?.outputTokens || 0);

        // Standard catalog per 1M tokens
        let inputPerM = 3.0;
        let outputPerM = 15.0;

        if (model.includes("haiku")) { inputPerM = 0.8; outputPerM = 4.0; }
        else if (model.includes("opus")) { inputPerM = 15.0; outputPerM = 75.0; }
        else if (model.includes("gemini-1.5-flash")) { inputPerM = 0.075; outputPerM = 0.3; }
        else if (model.includes("gemini-1.5-pro")) { inputPerM = 1.25; outputPerM = 5.0; }
        else if (model.includes("gpt-4o-mini")) { inputPerM = 0.15; outputPerM = 0.6; }
        else if (model.includes("gpt-4o")) { inputPerM = 2.5; outputPerM = 10.0; }
        else if (model.includes("ollama")) { inputPerM = 0.0; outputPerM = 0.0; }

        const costUsd = Number(((inputTokens / 1_000_000) * inputPerM + (outputTokens / 1_000_000) * outputPerM).toFixed(4));
        const totalTokens = inputTokens + outputTokens;

        this.sendJson(res, 200, {
          model,
          inputTokens,
          outputTokens,
          totalTokens,
          costUsd,
          formattedCost: `$${costUsd.toFixed(4)}`,
        });
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

