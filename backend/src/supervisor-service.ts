import { createHash } from "node:crypto";
import type {
  SupervisorInterviewRequest,
  SupervisorInterviewResponse,
  ClarificationQuestion,
  TrajectoryLoopCheckRequest,
  TrajectoryLoopCheckResponse,
} from "./types.ts";

export class SupervisorService {
  /**
   * Conducts Socratic product interview: asks 2-3 plain-English questions before coding,
   * or locks the specification once answers are provided.
   */
  public conductInterview(req: SupervisorInterviewRequest): SupervisorInterviewResponse {
    const prompt = req.featurePrompt.trim();
    const answers = req.developerAnswers;

    // Phase 1: If developer hasn't answered questions yet, formulate 2-3 product questions
    if (!answers || Object.keys(answers).length === 0) {
      const questions = this.generateClarificationQuestions(prompt);
      return {
        isRefined: false,
        clarificationQuestions: questions,
      };
    }

    // Phase 2: Answers provided -> compile locked specification and instructions for Agent 2
    const spec = this.compileSpecification(prompt, answers);
    return {
      isRefined: true,
      lockedSpecification: spec,
    };
  }

  /**
   * Analyzes agent tool trajectory to detect infinite debugging loops
   */
  public checkTrajectoryForLoops(req: TrajectoryLoopCheckRequest): TrajectoryLoopCheckResponse {
    const tools = req.recentTools;
    if (tools.length === 0) {
      return {
        loopDetected: false,
        consecutiveFailureCount: 0,
        recommendation: "CONTINUE",
        message: "Trajectory is healthy.",
      };
    }

    // Count consecutive failing tool runs
    let failCount = 0;
    let lastError: string | undefined;

    for (let i = tools.length - 1; i >= 0; i--) {
      const t = tools[i];
      if (t.exitCode !== undefined && t.exitCode !== 0) {
        failCount++;
        lastError = t.error || "Execution failed";
      } else {
        break;
      }
    }

    if (failCount >= 3) {
      return {
        loopDetected: true,
        consecutiveFailureCount: failCount,
        recommendation: "HALT_FOR_DEVELOPER",
        message: `Agent 2 is stuck in an execution loop (${failCount} consecutive failures). Halt recommended to prevent token waste.`,
      };
    } else if (failCount === 2) {
      return {
        loopDetected: false,
        consecutiveFailureCount: failCount,
        recommendation: "WARN_AGENT",
        message: `Agent 2 failed twice consecutively on '${lastError}'. Monitoring for loop threshold.`,
      };
    }

    return {
      loopDetected: false,
      consecutiveFailureCount: failCount,
      recommendation: "CONTINUE",
      message: "Trajectory is healthy.",
    };
  }

  private generateClarificationQuestions(prompt: string): ClarificationQuestion[] {
    const lower = prompt.toLowerCase();
    const questions: ClarificationQuestion[] = [];

    if (lower.includes("auth") || lower.includes("login") || lower.includes("user")) {
      questions.push({
        id: "Q1",
        question: "How should we handle new users vs existing account collisions?",
        whyItMatters: "Prevents account hijacking or creating orphaned duplicate accounts.",
        suggestedAnswers: [
          "Link account automatically if verified email matches.",
          "Prompt user to enter password before linking.",
          "Disallow collision and show an explicit error message.",
        ],
      });
      questions.push({
        id: "Q2",
        question: "What should be the session lifetime and refresh behavior?",
        whyItMatters: "Balances security compliance with user login friction.",
        suggestedAnswers: [
          "Short-lived access token (15m) + rotating refresh token (7 days).",
          "Single persistent session cookie (30 days).",
          "Stateless JWT stored in LocalStorage.",
        ],
      });
    } else if (lower.includes("pay") || lower.includes("billing") || lower.includes("stripe")) {
      questions.push({
        id: "Q1",
        question: "How should webhooks handle subscription cancellations?",
        whyItMatters: "Determines whether customer immediately loses access or keeps it until period end.",
        suggestedAnswers: [
          "Keep access active until end of billing period.",
          "Revoke access immediately with prorated refund.",
        ],
      });
      questions.push({
        id: "Q2",
        question: "What environment should be used for testing payments?",
        whyItMatters: "Ensures no live credit cards or actual webhooks are triggered.",
        suggestedAnswers: [
          "Mock Stripe SDK locally with synthetic test fixtures.",
          "Use Stripe CLI webhook forwarding in test mode.",
        ],
      });
    } else {
      questions.push({
        id: "Q1",
        question: "What is the primary edge case or failure mode that must be handled?",
        whyItMatters: "Ensures the AI writes defensive code rather than a happy-path prototype.",
        suggestedAnswers: [
          "Network/Database timeouts and transient failures.",
          "Invalid, missing, or malformed user payload.",
          "Concurrent requests modifying the same resource.",
        ],
      });
      questions.push({
        id: "Q2",
        question: "Are there existing libraries in the project that must be reused?",
        whyItMatters: "Prevents the agent from installing redundant npm packages.",
        suggestedAnswers: [
          "Reuse existing project utilities and helper functions.",
          "Allowed to add lightweight industry standard package.",
        ],
      });
    }

    return questions;
  }

  private compileSpecification(
    prompt: string,
    answers: Record<string, string>,
  ): {
    title: string;
    overview: string;
    acceptanceCriteria: string[];
    specHash: string;
    instructionsForAgent2: string;
  } {
    const title = prompt.length > 50 ? `${prompt.slice(0, 47)}...` : prompt;
    const overview = `Developer requested: "${prompt}". Resolved product choices: ${JSON.stringify(answers)}`;

    const criteria = [
      `AC-1: Core requirement implemented: ${prompt}`,
      ...Object.entries(answers).map(([qId, ans]) => `AC-${qId}: Decision honored: ${ans}`),
      "AC-TEST: Automated test suite passes with zero regressions.",
      "AC-TAMPER: Existing test assertions remain strictly intact.",
    ];

    const hash = createHash("sha256").update(JSON.stringify({ title, overview, criteria }), "utf8").digest("hex");

    const instructions = `You are Agent 2 (The Builder). Implement "${prompt}". You must strictly adhere to the following decisions: ${Object.values(answers).join("; ")}. Do not alter existing tests.`;

    return {
      title,
      overview,
      acceptanceCriteria: criteria,
      specHash: hash,
      instructionsForAgent2: instructions,
    };
  }
}
