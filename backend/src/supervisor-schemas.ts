/** What a supervisor run returns, and the JSON Schemas every provider is held to. */
export type SupervisorResult = {
  isRefined: boolean;
  clarificationQuestions?: Array<{ id: string; question: string; whyItMatters: string; suggestedAnswers: string[] }>;
  lockedSpecification?: {
    title: string;
    overview: string;
    acceptanceCriteria: string[];
    specHash: string;
    instructionsForAgent2: string;
    developerPrompt: string;
  };
};

export type ReviewResult = {
  summary: string;
  changes: Array<{ file: string; explanation: string }>;
  testsAndEvidence: string[];
  risks: string[];
  nextSteps: string[];
};

export const supervisorSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    isRefined: { type: "boolean" },
    clarificationQuestions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          whyItMatters: { type: "string" },
          suggestedAnswers: { type: "array", items: { type: "string" } },
        },
        required: ["id", "question", "whyItMatters", "suggestedAnswers"],
      },
    },
    lockedSpecification: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string" },
        overview: { type: "string" },
        acceptanceCriteria: { type: "array", items: { type: "string" } },
        specHash: { type: "string" },
        instructionsForAgent2: { type: "string" },
        developerPrompt: { type: "string" },
      },
      required: ["title", "overview", "acceptanceCriteria", "specHash", "instructionsForAgent2", "developerPrompt"],
    },
  },
  required: ["isRefined"],
} as const;

export const reviewSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { file: { type: "string" }, explanation: { type: "string" } },
        required: ["file", "explanation"],
      },
    },
    testsAndEvidence: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    nextSteps: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "changes", "testsAndEvidence", "risks", "nextSteps"],
} as const;
