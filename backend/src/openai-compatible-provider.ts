import {
  SupervisorError,
  interviewMode,
  classifyHttpStatus,
  classifyNetworkError,
  scrub,
  type RunContext,
  type RunMode,
  type SupervisorProvider,
} from "./supervisor-provider.ts";
import { reviewSchema, supervisorSchema, type ReviewResult, type SupervisorResult } from "./supervisor-schemas.ts";
import { dropNulls, validateResult } from "./validate-result.ts";

export interface OpenAICompatibleOptions {
  /** Already checked by the settings rules: https, or http only on this machine. */
  baseUrl: string;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
}

type Schema = {
  type: string | string[];
  properties?: Record<string, Schema>;
  required?: readonly string[];
  items?: Schema;
  additionalProperties?: boolean;
};

const SYSTEM = "Answer with one JSON object.";

/** Strict structured output rejects optional fields, so every field becomes required and the optional ones nullable. */
export function toStrictSchema(schema: unknown): unknown {
  const s = schema as Schema;
  if (s.type === "array" && s.items) return { ...s, items: toStrictSchema(s.items) };
  if (s.type !== "object") return { ...s };
  const properties = s.properties ?? {};
  const required = new Set(s.required ?? []);
  return {
    ...s,
    additionalProperties: false,
    required: Object.keys(properties),
    properties: Object.fromEntries(
      Object.entries(properties).map(([name, field]) => {
        const strict = toStrictSchema(field) as Schema;
        return [name, required.has(name) ? strict : { ...strict, type: [strict.type, "null"].flat() }];
      }),
    ),
  };
}

function stripFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?```\s*$/.exec(text);
  return fenced ? fenced[1] : text;
}

export class OpenAICompatibleProvider implements SupervisorProvider {
  private readonly o: OpenAICompatibleOptions;
  constructor(o: OpenAICompatibleOptions) {
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
    const res = await this.call("GET", "/models", undefined, AbortSignal.timeout(this.o.timeoutMs));
    const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  }

  /**
   * redirect: "error", so a server cannot bounce the request, and the key with it, to another address. Any failure
   * becomes a fixed code; the body goes to the log only after scrub.
   */
  private async call(method: "GET" | "POST", path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(`${this.o.baseUrl}${path}`, {
        method,
        redirect: "error",
        signal,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(this.o.apiKey ? { Authorization: `Bearer ${this.o.apiKey}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new SupervisorError(classifyNetworkError(err), { detail: scrub(String(err), this.o.apiKey) });
    }
    if (res.ok) return res;
    const text = await res.text().catch(() => "");
    const code = classifyHttpStatus(res.status);
    throw new SupervisorError(code, {
      detail: scrub(`HTTP ${res.status} ${text}`, this.o.apiKey),
      vars: { provider: "openai-compatible", model: this.o.model, status: res.status },
    });
  }

  private async run(mode: RunMode, ctx?: RunContext): Promise<SupervisorResult | ReviewResult> {
    if (!ctx?.context) throw new Error("OpenAICompatibleProvider needs the context built by the runner");
    const kind = mode === "review" ? "review" : "supervisor";
    const schema = kind === "review" ? reviewSchema : supervisorSchema;
    const model = ctx.model ?? this.o.model;
    const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(this.o.timeoutMs)]);
    const user = { role: "user", content: ctx.context };
    let res: Response;
    try {
      res = await this.call(
        "POST",
        "/chat/completions",
        {
          model,
          messages: [{ role: "system", content: SYSTEM }, user],
          response_format: {
            type: "json_schema",
            json_schema: { name: `${kind}_result`, schema: toStrictSchema(schema), strict: true },
          },
        },
        signal,
      );
    } catch (err) {
      // Many local servers reject response_format with a 400: ask once more with the schema in the prompt instead.
      if (!(err instanceof SupervisorError && err.vars.status === 400)) throw err;
      res = await this.call(
        "POST",
        "/chat/completions",
        {
          model,
          messages: [
            {
              role: "system",
              content: `Answer with one JSON object that matches this JSON Schema: ${JSON.stringify(schema)}`,
            },
            user,
          ],
        },
        signal,
      );
    }
    let choice: { finish_reason?: string; message?: { content?: string | null; refusal?: string | null } } | undefined;
    try {
      choice = ((await res.json()) as { choices?: (typeof choice)[] }).choices?.[0];
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        throw new SupervisorError("TIMEOUT", { detail: "answer not finished in time" });
      }
      throw new SupervisorError("INVALID_ANSWER", { detail: "response is not JSON" });
    }
    if (choice?.message?.refusal) throw new SupervisorError("REFUSED", { detail: "the model set refusal" });
    const content = choice?.message?.content;
    if (choice?.finish_reason === "length" || typeof content !== "string") {
      throw new SupervisorError("INVALID_ANSWER", { detail: `finish_reason ${choice?.finish_reason ?? "none"}` });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stripFence(content));
    } catch {
      throw new SupervisorError("INVALID_ANSWER", { detail: "answer is not JSON" });
    }
    return validateResult(kind, dropNulls(parsed));
  }
}
