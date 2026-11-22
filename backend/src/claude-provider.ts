import type * as SdkModule from "@anthropic-ai/sdk";
import type { BetaMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import {
  SupervisorError,
  interviewMode,
  scrub,
  type RunContext,
  type RunMode,
  type SupervisorProvider,
} from "./supervisor-provider.ts";
import { reviewSchema, supervisorSchema, type ReviewResult, type SupervisorResult } from "./supervisor-schemas.ts";
import { validateResult } from "./validate-result.ts";

type Sdk = typeof SdkModule;

/** Pinned so an ANTHROPIC_BASE_URL in the shell cannot send the saved key to another host. Tests pass a loopback URL. */
export const ANTHROPIC_API_URL = "https://api.anthropic.com";

/** Models that accept server-side fallback; on a refusal the API reruns the request on a model chosen for that refusal. */
const FALLBACK_MODELS: ReadonlySet<string> = new Set([
  "claude-fable-5-2",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
]);

let sdkLoad: Promise<Sdk> | undefined;
/** Loaded on first use: the Docker image ships no node_modules, and Codex users never need the SDK. */
const loadSdk = (): Promise<Sdk> => (sdkLoad ??= import("@anthropic-ai/sdk"));

export interface ClaudeOptions {
  apiKey: string;
  model: string;
  baseURL?: string;
  timeoutMs: number;
}

function classify(sdk: Sdk, err: unknown, apiKey: string, model: string): SupervisorError {
  if (err instanceof SupervisorError) return err;
  const detail = scrub(err instanceof Error ? err.message : String(err), apiKey);
  // Most specific first: the abort and timeout classes are also connection errors.
  if (err instanceof sdk.APIUserAbortError || err instanceof sdk.APIConnectionTimeoutError) {
    return new SupervisorError("TIMEOUT", { detail });
  }
  if (err instanceof sdk.APIConnectionError) return new SupervisorError("UNREACHABLE", { detail });
  if (err instanceof sdk.AuthenticationError || err instanceof sdk.PermissionDeniedError) {
    return new SupervisorError("KEY_REJECTED", { detail, vars: { provider: "claude" } });
  }
  if (err instanceof sdk.NotFoundError) {
    return new SupervisorError("MODEL_NOT_FOUND", { detail, vars: { provider: "claude", model } });
  }
  if (err instanceof sdk.RateLimitError) return new SupervisorError("RATE_LIMITED", { detail });
  const status = err instanceof sdk.APIError ? (err.status ?? 0) : 0;
  return new SupervisorError("PROVIDER_ERROR", { detail, vars: { status } });
}

export class ClaudeProvider implements SupervisorProvider {
  private readonly o: ClaudeOptions;
  constructor(o: ClaudeOptions) {
    this.o = o;
  }

  async interview(
    _featurePrompt: string,
    developerAnswers?: Record<string, string>,
    ctx?: RunContext,
  ): Promise<SupervisorResult> {
    return (await this.run(interviewMode(developerAnswers), ctx)) as SupervisorResult;
  }

  async review(ctx?: RunContext): Promise<ReviewResult> {
    return (await this.run("review", ctx)) as ReviewResult;
  }

  async listModels(): Promise<string[]> {
    const sdk = await loadSdk();
    try {
      const page = await this.client(sdk).models.list({ limit: 1000 });
      return page.data.map((m) => m.id);
    } catch (err) {
      throw classify(sdk, err, this.o.apiKey, this.o.model);
    }
  }

  private client(sdk: Sdk) {
    // authToken: null, so an ANTHROPIC_AUTH_TOKEN in the environment is never sent next to the saved key.
    return new sdk.default({
      apiKey: this.o.apiKey,
      authToken: null,
      baseURL: this.o.baseURL ?? ANTHROPIC_API_URL,
      timeout: this.o.timeoutMs,
      maxRetries: 0,
    });
  }

  private async run(mode: RunMode, ctx?: RunContext): Promise<SupervisorResult | ReviewResult> {
    if (!ctx?.context) throw new Error("ClaudeProvider needs the context built by the runner");
    const sdk = await loadSdk();
    const model = ctx.model ?? this.o.model;
    const kind = mode === "review" ? "review" : "supervisor";
    let message: BetaMessage;
    try {
      // Streamed: a 200 KB context at high effort can stay silent for minutes, which non-streaming calls do badly.
      message = await this.client(sdk)
        .beta.messages.stream(
          {
            model,
            max_tokens: mode === "review" ? 32_000 : 16_000,
            ...(FALLBACK_MODELS.has(model)
              ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }
              : {}),
            messages: [{ role: "user", content: ctx.context }],
            output_config: {
              effort: mode === "review" ? "high" : "medium",
              format: {
                type: "json_schema",
                schema: (kind === "review" ? reviewSchema : supervisorSchema) as unknown as Record<string, unknown>,
              },
            },
          },
          { signal: ctx.signal },
        )
        .finalMessage();
    } catch (err) {
      throw classify(sdk, err, this.o.apiKey, model);
    }
    if (message.stop_reason === "refusal") {
      throw new SupervisorError("REFUSED", { detail: `refusal category ${message.stop_details?.category ?? "none"}` });
    }
    const text = message.content.find((block) => block.type === "text");
    if (message.stop_reason === "max_tokens" || !text || text.type !== "text") {
      throw new SupervisorError("INVALID_ANSWER", { detail: `stop_reason ${message.stop_reason ?? "none"}` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text.text);
    } catch {
      throw new SupervisorError("INVALID_ANSWER", { detail: "answer is not JSON" });
    }
    return validateResult(kind, parsed);
  }
}
