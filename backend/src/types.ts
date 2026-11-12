export interface SessionSummary {
  id: string;
  agentType: string;
  projectPath: string;
  gitBranch: string;
  status: "active" | "completed" | "aborted" | "paused";
  startedAt: number;
  endedAt?: number;
  eventsCount?: number;
}

export interface WSEventMessage {
  type:
    | "agent_tool_executing"
    | "agent_tool_completed"
    | "agent_session_updated"
    | "policy_verdict_emitted"
    | "circuit_breaker_alert"
    | "spec_updated"
    | "verification_completed";
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  whyItMatters: string;
  suggestedAnswers: string[];
}

export interface SupervisorInterviewRequest {
  featurePrompt: string;
  projectContext?: string;
  developerAnswers?: Record<string, string>;
}

export interface SupervisorInterviewResponse {
  isRefined: boolean;
  clarificationQuestions?: ClarificationQuestion[];
  lockedSpecification?: {
    title: string;
    overview: string;
    acceptanceCriteria: string[];
    specHash: string;
    instructionsForAgent2: string;
  };
}

export interface TrajectoryLoopCheckRequest {
  sessionId: string;
  recentTools: Array<{ toolName: string; input: unknown; exitCode?: number; error?: string }>;
}

export interface TrajectoryLoopCheckResponse {
  loopDetected: boolean;
  consecutiveFailureCount: number;
  recommendation: "CONTINUE" | "WARN_AGENT" | "HALT_FOR_DEVELOPER";
  message: string;
}
