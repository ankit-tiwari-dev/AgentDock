import { SupervisorError } from "./supervisor-provider.ts";
import { reviewSchema, supervisorSchema, type ReviewResult, type SupervisorResult } from "./supervisor-schemas.ts";

/** The subset of JSON Schema the two result schemas use. */
type Schema = {
  type: "object" | "array" | "string" | "boolean";
  properties?: Readonly<Record<string, Schema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: Schema;
};

function matches(schema: Schema, value: unknown): boolean {
  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value) && (!schema.items || value.every((item) => matches(schema.items!, item)));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      if ((schema.required ?? []).some((key) => !(key in record))) return false;
      return Object.entries(record).every(([key, field]) =>
        key in properties ? matches(properties[key], field) : schema.additionalProperties !== false,
      );
    }
  }
}

/**
 * Codex enforces the schema itself through --output-schema; an API answer is only text, so it is checked here before
 * anything uses it. Hand-written for the two fixed schemas, so the backend needs no schema library.
 */
export function validateResult(kind: "supervisor", value: unknown): SupervisorResult;
export function validateResult(kind: "review", value: unknown): ReviewResult;
export function validateResult(kind: "supervisor" | "review", value: unknown): SupervisorResult | ReviewResult;
export function validateResult(kind: "supervisor" | "review", value: unknown): SupervisorResult | ReviewResult {
  const schema = (kind === "supervisor" ? supervisorSchema : reviewSchema) as unknown as Schema;
  if (!matches(schema, value)) {
    throw new SupervisorError("INVALID_ANSWER", { detail: `answer does not match the ${kind} schema` });
  }
  return value as SupervisorResult | ReviewResult;
}

/** Strict structured output makes every field required, so unused optional fields arrive as null; drop them. */
export function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== null)
      .map(([key, field]) => [key, dropNulls(field)]),
  );
}
