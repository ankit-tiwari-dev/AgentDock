"use client";

import { type FormEvent, useState } from "react";
import { PageHead } from "./page-parts";

type Question = { id: string; question: string; whyItMatters: string; suggestedAnswers: string[] };
type LockedSpec = {
  title: string;
  overview: string;
  specHash: string;
  acceptanceCriteria: string[];
  developerPrompt?: string;
  instructionsForAgent2?: string;
};
type Interview = { clarificationQuestions?: Question[]; lockedSpecification?: LockedSpec };
type Review = {
  summary: string;
  changes: Array<{ file: string; explanation: string }>;
  testsAndEvidence: string[];
  risks: string[];
  nextSteps: string[];
};

/** Codex writes a developer prompt; the built-in supervisor writes instructions for the coding agent. */
const handoffText = (spec: LockedSpec) => spec.developerPrompt ?? spec.instructionsForAgent2 ?? "";

type Props = {
  apiOrigin: string;
  codexEnabled: boolean;
  onCopy: (text: string, label: string) => void;
  onToast: (message: string) => void;
};

export default function PlanReview({ apiOrigin, codexEnabled, onCopy, onToast }: Props) {
  const [prompt, setPrompt] = useState("");
  const [interview, setInterview] = useState<Interview | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState<"plan" | "handoff" | "review" | null>(null);

  async function postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${apiOrigin}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error((await response.json()).error || "Request failed");
    return response.json() as Promise<T>;
  }

  async function ask(event: FormEvent) {
    event.preventDefault();
    if (!prompt.trim()) return;
    setBusy("plan");
    setInterview(null);
    try {
      const result = await postJson<Interview>("/api/supervisor/interview", { featurePrompt: prompt });
      setInterview(result);
      const questions = result.clarificationQuestions || [];
      setAnswers(Object.fromEntries(questions.map((question) => [question.id, question.suggestedAnswers[0]])));
    } catch (error) {
      onToast(
        error instanceof Error ? error.message : "The supervisor did not answer. Check that the backend is running.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function writeHandoff() {
    setBusy("handoff");
    try {
      setInterview(
        await postJson<Interview>("/api/supervisor/interview", { featurePrompt: prompt, developerAnswers: answers }),
      );
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The handoff could not be written.");
    } finally {
      setBusy(null);
    }
  }

  async function explain() {
    setBusy("review");
    setReview(null);
    try {
      setReview(await postJson<Review>("/api/reviewer/explain", {}));
    } catch (error) {
      onToast(error instanceof Error ? error.message : "The reviewer did not answer.");
    } finally {
      setBusy(null);
    }
  }

  const questions = interview?.clarificationQuestions;
  const spec = interview?.lockedSpecification;

  return (
    <>
      <PageHead
        title="Plan & review"
        lede="Settle the product questions before an agent writes code, then get the finished changes explained in plain words."
      />
      <div className="pg-steps">
        <section className="pg-box pg-step" aria-labelledby="pg-step-plan">
          <div className="pg-step-head">
            <span className="pg-num" aria-hidden="true">
              1
            </span>
            <div>
              <h2 id="pg-step-plan">Plan before coding</h2>
              <p>
                Describe the change. The supervisor asks the questions an agent would otherwise guess, then writes a
                handoff you paste into your coding agent.
              </p>
            </div>
          </div>
          <div className="pg-step-body">
            <form onSubmit={ask}>
              <label className="pg-field" htmlFor="pg-feature">
                What do you want to build?
              </label>
              <textarea
                id="pg-feature"
                className="pg-textarea"
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                rows={4}
                placeholder="For example: add two-step login with an authenticator app"
              />
              <div className="pg-form-foot">
                <span>
                  {codexEnabled
                    ? "A read-only Codex run reads this repository to ask its questions."
                    : "Answered by the built-in supervisor. Codex is off."}
                </span>
                <button type="submit" className="ov-btn pg-primary" disabled={busy !== null || !prompt.trim()}>
                  {busy === "plan" ? "Asking the supervisor…" : "Ask the supervisor"}
                </button>
              </div>
            </form>
            {questions && questions.length > 0 && !spec && (
              <div className="pg-questions">
                {questions.map((question) => (
                  <fieldset key={question.id} className="pg-q">
                    <legend>{question.question}</legend>
                    <p>{question.whyItMatters}</p>
                    {question.suggestedAnswers.map((answer) => (
                      <label className="pg-choice" key={answer}>
                        <input
                          type="radio"
                          name={question.id}
                          checked={answers[question.id] === answer}
                          onChange={() => setAnswers((current) => ({ ...current, [question.id]: answer }))}
                        />
                        <span>{answer}</span>
                      </label>
                    ))}
                  </fieldset>
                ))}
                <button
                  type="button"
                  className="ov-btn pg-primary"
                  disabled={busy !== null || !Object.keys(answers).length}
                  onClick={writeHandoff}
                >
                  {busy === "handoff" ? "Writing the handoff…" : "Write the handoff"}
                </button>
              </div>
            )}
            {spec && (
              <div className="pg-handoff">
                <h3>Handoff ready</h3>
                <p className="pg-handoff-title">{spec.title}</p>
                <ul>
                  {spec.acceptanceCriteria.map((criterion) => (
                    <li key={criterion}>{criterion}</li>
                  ))}
                </ul>
                <h3>{codexEnabled ? "Prompt for your developer Codex" : "Handoff for your coding agent"}</h3>
                <pre className="ov-pre">{handoffText(spec)}</pre>
                <button type="button" className="ov-btn ov-btn-sm" onClick={() => onCopy(handoffText(spec), "Handoff")}>
                  Copy handoff
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="pg-box pg-step" aria-labelledby="pg-step-review">
          <div className="pg-step-head">
            <span className="pg-num" aria-hidden="true">
              2
            </span>
            <div>
              <h2 id="pg-step-review">Explain the changes</h2>
              <p>
                When the agent has finished, a separate read-only Codex run reads the git diff and explains each changed
                file, the tests and the risks.
              </p>
            </div>
          </div>
          <div className="pg-step-body">
            {!codexEnabled && (
              <p className="pg-note pg-note-box">
                Explaining needs Codex. Restart the backend with <code>AGENTDOCK_CODEX=1</code> to turn it on.
              </p>
            )}
            <button
              type="button"
              className="ov-btn pg-primary"
              disabled={busy !== null || !codexEnabled}
              onClick={explain}
            >
              {busy === "review" ? "Reading the changes…" : "Explain the changes"}
            </button>
            {review && (
              <div className="pg-review">
                <p>{review.summary}</p>
                <h3>Files</h3>
                {review.changes.length ? (
                  <dl className="ov-kv">
                    {review.changes.map((change) => (
                      <div key={change.file} className="pg-kv-pair">
                        <dt className="ov-mono">{change.file}</dt>
                        <dd>{change.explanation}</dd>
                      </div>
                    ))}
                  </dl>
                ) : (
                  <p className="ov-muted">No changed files were reported.</p>
                )}
                <div className="pg-review-cols">
                  <ReviewList title="Tests and evidence" items={review.testsAndEvidence} />
                  <ReviewList title="Risks" items={review.risks} />
                  <ReviewList title="Next steps" items={review.nextSteps} />
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

function ReviewList({ title, items }: { title: string; items: string[] }) {
  return (
    <div>
      <h3>{title}</h3>
      {items.length ? (
        <ul>
          {items.map((item, index) => (
            <li key={`${title}-${index}`}>{item}</li>
          ))}
        </ul>
      ) : (
        <p className="ov-muted">None reported.</p>
      )}
    </div>
  );
}
