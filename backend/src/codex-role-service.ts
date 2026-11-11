import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type SupervisorResult = {
  isRefined: boolean;
  clarificationQuestions?: Array<{ id: string; question: string; whyItMatters: string; suggestedAnswers: string[] }>;
  lockedSpecification?: { title: string; overview: string; acceptanceCriteria: string[]; specHash: string; instructionsForAgent2: string; developerPrompt: string };
};

export type ReviewResult = { summary: string; changes: Array<{ file: string; explanation: string }>; testsAndEvidence: string[]; risks: string[]; nextSteps: string[] };

const supervisorSchema = {
  type: "object", additionalProperties: false,
  properties: {
    isRefined: { type: "boolean" },
    clarificationQuestions: { type: "array", items: { type: "object", additionalProperties: false, properties: { id: { type: "string" }, question: { type: "string" }, whyItMatters: { type: "string" }, suggestedAnswers: { type: "array", items: { type: "string" } } }, required: ["id", "question", "whyItMatters", "suggestedAnswers"] } },
    lockedSpecification: { type: "object", additionalProperties: false, properties: { title: { type: "string" }, overview: { type: "string" }, acceptanceCriteria: { type: "array", items: { type: "string" } }, specHash: { type: "string" }, instructionsForAgent2: { type: "string" }, developerPrompt: { type: "string" } }, required: ["title", "overview", "acceptanceCriteria", "specHash", "instructionsForAgent2", "developerPrompt"] },
  }, required: ["isRefined"],
} as const;

const reviewSchema = {
  type: "object", additionalProperties: false, properties: {
    summary: { type: "string" }, changes: { type: "array", items: { type: "object", additionalProperties: false, properties: { file: { type: "string" }, explanation: { type: "string" } }, required: ["file", "explanation"] } },
    testsAndEvidence: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, nextSteps: { type: "array", items: { type: "string" } },
  }, required: ["summary", "changes", "testsAndEvidence", "risks", "nextSteps"],
} as const;

export class CodexRoleService {
  private readonly projectPath: string;
  constructor(projectPath = process.cwd()) { this.projectPath = projectPath; }

  async interview(featurePrompt: string, developerAnswers?: Record<string, string>): Promise<SupervisorResult> {
    const mode = developerAnswers ? "finalize" : "questions";
    const prompt = mode === "questions"
      ? `You are the product supervisor for this software repository. Inspect relevant files read-only, then clarify the feature request below. Ask 2-4 concrete, high-impact questions only where repository context and the request do not already answer them. Suggested answers should be short, realistic choices. Do not implement or edit files. Return isRefined=false and clarificationQuestions; omit lockedSpecification.\n\nFEATURE REQUEST:\n${featurePrompt}`
      : `You are the product supervisor for this software repository. Use the feature request, the user's answers, and repository context to produce a precise implementation specification. Do not edit files. Return isRefined=true, an empty clarificationQuestions array, and lockedSpecification including a concise title, overview, testable acceptance criteria, a short identifier in specHash, and a complete developerPrompt. The developerPrompt must include the original request, each user's answer, repository-specific constraints, and acceptance criteria. Tell the developer to inspect the project, implement the feature, run relevant tests, and report changed files and evidence.\n\nFEATURE REQUEST:\n${featurePrompt}\n\nUSER ANSWERS (JSON):\n${JSON.stringify(developerAnswers)}`;
    return this.runStructured<SupervisorResult>(prompt, supervisorSchema);
  }

  async review(): Promise<ReviewResult> {
    const prompt = "Review the current repository changes for the user. Inspect git status, git diff HEAD, and relevant changed files read-only. Explain in plain, simple English what changed and how it works. Report tests only when there is evidence in the repository or command output; do not claim tests were run if you did not run them. Mention concrete risks and useful next steps. Do not edit files. If the working tree has no changes, say so clearly in the summary and changes list.";
    return this.runStructured<ReviewResult>(prompt, reviewSchema);
  }

  private async runStructured<T>(prompt: string, schema: object): Promise<T> {
    const tempDir = await mkdtemp(join(tmpdir(), "agentdock-codex-"));
    const schemaPath = join(tempDir, "schema.json");
    const outputPath = join(tempDir, "result.json");
    await writeFile(schemaPath, JSON.stringify(schema), "utf8");
    const executable = process.env.AGENTDOCK_CODEX_PATH || (process.platform === "win32" ? "codex.exe" : "codex");
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(executable, ["exec", "--ephemeral", "--sandbox", "read-only", "--cd", this.projectPath, "--output-schema", schemaPath, "--output-last-message", outputPath, "-"], { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
        let stderr = "";
        const timeout = setTimeout(() => { child.kill(); reject(new Error("Codex role timed out after 3 minutes.")); }, 180_000);
        child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-6000); });
        child.on("error", (error) => { clearTimeout(timeout); reject(new Error(`Could not start Codex CLI (${executable}): ${error.message}`)); });
        child.on("close", (code) => { clearTimeout(timeout); if (code === 0) resolve(); else reject(new Error(`Codex CLI exited with code ${code}. ${stderr.trim()}`)); });
        child.stdin.end(prompt);
      });
      return JSON.parse(await readFile(outputPath, "utf8")) as T;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
