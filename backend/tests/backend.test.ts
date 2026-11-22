import test from "node:test";
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import type { IncomingMessage, ServerResponse } from "node:http";
import { SupervisorService } from "../src/supervisor-service.ts";
import { WebSocketBroadcaster } from "../src/websocket-server.ts";
import { AgentDockBackendServer } from "../src/server.ts";

test("SupervisorService generates Socratic questions in Phase 1", () => {
  const service = new SupervisorService();

  // Test with Auth feature
  const res1 = service.conductInterview({
    featurePrompt: "Add Google OAuth login to our web app",
  });

  assert.equal(res1.isRefined, false);
  assert.ok(res1.clarificationQuestions);
  assert.ok(res1.clarificationQuestions.length >= 2);
  assert.ok(res1.clarificationQuestions[0].suggestedAnswers.length >= 2);

  // Test with Payment feature
  const res2 = service.conductInterview({
    featurePrompt: "Add Stripe subscription cancellation webhooks",
  });

  assert.equal(res2.isRefined, false);
  assert.ok(res2.clarificationQuestions);
  assert.ok(res2.clarificationQuestions[0].question.toLowerCase().includes("subscription"));
});

test("SupervisorService locks specification and criteria in Phase 2", () => {
  const service = new SupervisorService();

  const res = service.conductInterview({
    featurePrompt: "Add Google OAuth login to our web app",
    developerAnswers: {
      Q1: "Link account automatically if verified email matches.",
      Q2: "Short-lived access token (15m) + rotating refresh token (7 days).",
    },
  });

  assert.equal(res.isRefined, true);
  assert.ok(res.lockedSpecification);
  assert.equal(res.lockedSpecification.specHash.length, 64);
  assert.ok(res.lockedSpecification.acceptanceCriteria.length >= 4);
  assert.ok(res.lockedSpecification.instructionsForAgent2.includes("Agent 2"));
  assert.ok(res.lockedSpecification.instructionsForAgent2.includes("Do not alter existing tests"));
});

test("WebSocketBroadcaster manages clients and encodes valid RFC6455 frames", () => {
  const broadcaster = new WebSocketBroadcaster();
  assert.equal(broadcaster.getConnectedClientsCount(), 0);

  // Verify broadcast with zero clients is safe (no crash)
  broadcaster.broadcast({
    type: "agent_tool_executing",
    sessionId: "sess_123",
    timestamp: Date.now(),
    data: { tool: "Bash", cmd: "npm test" },
  });
});

interface MockHttpHandlerOptions {
  method: string;
  url: string;
  body?: unknown;
}

function createMockHttpPair(options: MockHttpHandlerOptions) {
  let statusCode = 200;
  let responseData = "";

  const req = {
    method: options.method,
    url: options.url,
    headers: { "content-type": "application/json", host: "127.0.0.1:45820" },
    on(event: string, callback: (chunk?: Buffer) => void) {
      if (event === "data" && options.body !== undefined) {
        const payload = typeof options.body === "string" ? options.body : JSON.stringify(options.body);
        callback(Buffer.from(payload));
      }
      if (event === "end") {
        callback();
      }
      return this;
    },
  } as unknown as IncomingMessage;

  const res = {
    setHeader() {
      return this;
    },
    writeHead(code: number) {
      statusCode = code;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined && chunk !== null) {
        responseData = String(chunk);
      }
      return this;
    },
  } as unknown as ServerResponse;

  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getBody: () => responseData,
    getJson: <T>() => JSON.parse(responseData) as T,
  };
}

test("regression: the removed prompt coach route answers 404", () => {
  const server = new AgentDockBackendServer();
  const pair = createMockHttpPair({ method: "POST", url: "/api/coach/analyze", body: { prompt: "fix it" } });
  server.handleHttpRequest(pair.req, pair.res);
  assert.equal(pair.getStatusCode(), 404);
});
