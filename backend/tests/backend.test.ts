import test from "node:test";
import assert from "node:assert/strict";
import { SupervisorService } from "../src/supervisor-service.ts";
import { WebSocketBroadcaster } from "../src/websocket-server.ts";

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

test("SupervisorService detects infinite debugging loops in trajectory", () => {
  const service = new SupervisorService();

  // Healthy trajectory (passes or single failure)
  const healthy = service.checkTrajectoryForLoops({
    sessionId: "sess_1",
    recentTools: [
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
      { toolName: "Bash", input: "npm test", exitCode: 0 },
    ],
  });
  assert.equal(healthy.loopDetected, false);
  assert.equal(healthy.recommendation, "CONTINUE");

  // Warning threshold (2 consecutive failures)
  const warn = service.checkTrajectoryForLoops({
    sessionId: "sess_2",
    recentTools: [
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
    ],
  });
  assert.equal(warn.loopDetected, false);
  assert.equal(warn.recommendation, "WARN_AGENT");

  // Loop threshold (3 consecutive failures -> HALT)
  const loop = service.checkTrajectoryForLoops({
    sessionId: "sess_3",
    recentTools: [
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
      { toolName: "Bash", input: "npm test", exitCode: 1, error: "Syntax error" },
    ],
  });
  assert.equal(loop.loopDetected, true);
  assert.equal(loop.recommendation, "HALT_FOR_DEVELOPER");
  assert.equal(loop.consecutiveFailureCount, 3);
  assert.ok(loop.message.includes("stuck in an execution loop"));
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
