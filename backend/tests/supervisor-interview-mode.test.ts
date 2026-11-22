import test from "node:test";
import assert from "node:assert/strict";
import { KEYS, PLAN, PROVIDERS, QUESTIONS, withApiBackend } from "./supervisor-api-harness.ts";

const NO_DECISION = [{}, { q1: "" }, { q1: "   " }];

test("regression: answers with no decision in them get questions, not a locked plan, from each API provider", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake, logs }) => {
    for (const provider of PROVIDERS) {
      use(provider);
      for (const developerAnswers of NO_DECISION) {
        const res = await post("/api/supervisor/interview", { featurePrompt: "Add Google login", developerAnswers });
        const label = `${provider} ${JSON.stringify(developerAnswers)}`;
        assert.equal(res.status, 200, label);
        assert.equal(res.json.isRefined, false, label);
        assert.deepEqual(res.json.clarificationQuestions, QUESTIONS.clarificationQuestions, label);
        assert.equal(res.json.lockedSpecification, undefined, label);
        assert.doesNotMatch(fake.calls.at(-1)!.context, /USER ANSWERS/, label);
        assert.equal(logs.at(-1)!.mode, "questions", label);
      }
    }
  });
});

test("regression: answers with no decision in them get questions from the built-in interview", async () => {
  await withApiBackend({}, async ({ post, fake }) => {
    for (const developerAnswers of NO_DECISION) {
      const res = await post("/api/supervisor/interview", { featurePrompt: "Add Google login", developerAnswers });
      const label = JSON.stringify(developerAnswers);
      assert.equal(res.status, 200, label);
      assert.equal(res.json.isRefined, false, label);
      assert.ok((res.json.clarificationQuestions as unknown[]).length > 0, label);
      assert.equal(res.json.lockedSpecification, undefined, label);
    }
    assert.equal(fake.calls.length, 0);
  });
});

test("regression: one real answer locks the plan with each API provider and the built-in interview", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake }) => {
    const body = { featurePrompt: "Add Google login", developerAnswers: { q1: "Google", q2: "" } };
    const builtIn = await post("/api/supervisor/interview", body);
    assert.equal(builtIn.status, 200);
    assert.equal(builtIn.json.isRefined, true);
    assert.ok(builtIn.json.lockedSpecification);
    for (const provider of PROVIDERS) {
      use(provider);
      const res = await post("/api/supervisor/interview", body);
      assert.equal(res.status, 200, provider);
      assert.deepEqual(res.json.lockedSpecification, PLAN.lockedSpecification, provider);
      assert.match(fake.calls.at(-1)!.context, /USER ANSWERS/, provider);
    }
  });
});

test("regression: developerAnswers that is not an object of strings is refused with 400 before any run", async () => {
  await withApiBackend({ keys: KEYS }, async ({ use, post, fake, logs }) => {
    const malformed = [null, "Google", 1, ["Google"], { q1: 1 }, { q1: ["Google"] }, { q1: null }, { q1: { a: "b" } }];
    for (const setup of ["built-in", ...PROVIDERS] as const) {
      if (setup !== "built-in") use(setup);
      for (const developerAnswers of malformed) {
        const res = await post("/api/supervisor/interview", { featurePrompt: "Add Google login", developerAnswers });
        assert.equal(res.status, 400, `${setup} ${JSON.stringify(developerAnswers)}`);
      }
    }
    assert.equal(fake.calls.length, 0);
    assert.equal(logs.length, 0);
  });
});
