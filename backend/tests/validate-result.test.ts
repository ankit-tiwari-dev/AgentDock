import test from "node:test";
import assert from "node:assert/strict";
import { dropNulls, validateResult } from "../src/validate-result.ts";

const questions = {
  isRefined: false,
  clarificationQuestions: [{ id: "q1", question: "Which login?", whyItMatters: "Scope", suggestedAnswers: ["Google"] }],
};
const plan = {
  isRefined: true,
  clarificationQuestions: [],
  lockedSpecification: {
    title: "Login",
    overview: "Add Google login",
    acceptanceCriteria: ["Users sign in"],
    specHash: "abc",
    instructionsForAgent2: "Build it",
    developerPrompt: "Implement Google login",
  },
};
const review = {
  summary: "Changed one file",
  changes: [{ file: "a.ts", explanation: "Adds a flag" }],
  testsAndEvidence: [],
  risks: ["None seen"],
  nextSteps: [],
};

const invalid = (kind: "supervisor" | "review", value: unknown) =>
  assert.throws(() => validateResult(kind, value), { code: "INVALID_ANSWER" }, JSON.stringify(value));

test("answers valid against supervisorSchema and reviewSchema pass; a missing field, a wrong type or an extra field gives INVALID_ANSWER", () => {
  assert.deepEqual(validateResult("supervisor", questions), questions);
  assert.deepEqual(validateResult("supervisor", plan), plan);
  assert.deepEqual(validateResult("supervisor", { isRefined: false }), { isRefined: false });
  assert.deepEqual(validateResult("review", review), review);

  invalid("supervisor", {});
  invalid("supervisor", { isRefined: "yes" });
  invalid("supervisor", { ...questions, extra: 1 });
  invalid("supervisor", { isRefined: false, clarificationQuestions: [{ id: "q1", question: "x", whyItMatters: "y" }] });
  invalid("supervisor", {
    isRefined: false,
    clarificationQuestions: [{ ...questions.clarificationQuestions[0], suggestedAnswers: [1] }],
  });
  invalid("supervisor", { ...plan, lockedSpecification: { ...plan.lockedSpecification, secret: "x" } });
  invalid("review", { ...review, changes: [{ file: "a.ts" }] });
  invalid("review", { ...review, risks: "none" });
  invalid("review", null);
  invalid("review", [review]);
});

test("the strict-mode nulls an OpenAI-compatible server sends for unused optional fields are dropped before checking", () => {
  const strict = {
    isRefined: false,
    clarificationQuestions: questions.clarificationQuestions,
    lockedSpecification: null,
  };
  assert.deepEqual(validateResult("supervisor", dropNulls(strict)), questions);
  invalid("supervisor", strict);
});
