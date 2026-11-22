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
  type: "agent_tool_executing" | "agent_tool_completed" | "agent_session_updated";
  sessionId: string;
  timestamp: number;
  data: Record<string, unknown>;
  /** The id of the project whose audit log the event came from (`GET /api/projects`). */
  project?: string;
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
