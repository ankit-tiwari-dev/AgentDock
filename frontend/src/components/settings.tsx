"use client";

import { type FormEvent, Fragment, useEffect, useState } from "react";
import {
  type ModelList,
  type ProviderName,
  type SettingsView,
  PROVIDER_LABEL,
  settingsView,
  supervisorStatus,
} from "@/lib/settings";
import { PageHead } from "./page-parts";

const CHOICES: Array<{ value: ProviderName; title: string; note: string }> = [
  { value: "codex", title: "Codex CLI", note: "Runs Codex on this machine. No key needed." },
  { value: "claude", title: "Claude", note: "Anthropic API. Needs a saved key." },
  { value: "openai-compatible", title: "OpenAI-compatible", note: "Any server with the OpenAI API, such as Ollama." },
];
const BASE_URL_COMMAND = "ctrlplane supervisor use openai-compatible <model> --base-url <url>";

type Props = {
  apiOrigin: string;
  onCopy: (text: string, label: string) => void;
  onToast: (message: string) => void;
};

async function readJson<T>(response: Response): Promise<T> {
  const body = (await response.json()) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

function CopyCommand({ command, label, onCopy }: { command: string; label: string; onCopy: Props["onCopy"] }) {
  return (
    <div className="pg-cmd">
      <code>{command}</code>
      <button type="button" className="ov-btn ov-btn-sm" aria-label={label} onClick={() => onCopy(command, "Command")}>
        Copy
      </button>
    </div>
  );
}

export default function Settings({ apiOrigin, onCopy, onToast }: Props) {
  const [view, setView] = useState<SettingsView | null>(null);
  const [loadError, setLoadError] = useState("");
  const [picked, setPicked] = useState<ProviderName>("claude");
  const [models, setModels] = useState<ModelList | null>(null);
  const [modelsError, setModelsError] = useState("");
  const [selected, setSelected] = useState("");
  const [codexModel, setCodexModel] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  useEffect(() => {
    fetch(`${apiOrigin}/api/supervisor/settings`, { cache: "no-store" })
      .then((response) => readJson<SettingsView>(response))
      .then((loaded) => {
        setView(loaded);
        setPicked(loaded.provider ?? "claude");
        if (loaded.provider === "codex") setCodexModel(loaded.model ?? "");
      })
      .catch(() => setLoadError("The settings could not be loaded. Is the backend running?"));
  }, [apiOrigin]);

  // The list comes from the provider with the saved key, so it is fetched only for the provider picked.
  useEffect(() => {
    setModels(null);
    setModelsError("");
    if (picked === "codex" || !view) return;
    let current = true;
    fetch(`${apiOrigin}/api/supervisor/models?provider=${encodeURIComponent(picked)}`, { cache: "no-store" })
      .then((response) => readJson<ModelList>(response))
      .then((list) => {
        if (!current) return;
        setModels(list);
        setSelected(list.current ?? list.models[0] ?? "");
      })
      .catch((error: Error) => current && setModelsError(error.message));
    return () => {
      current = false;
    };
  }, [apiOrigin, picked, view]);

  if (!view) {
    return (
      <>
        <PageHead title="Settings" lede="Which AI the supervisor in Plan & review uses." />
        <p className="pg-note">{loadError || "Loading settings…"}</p>
      </>
    );
  }

  const shown = settingsView(view, models);
  const status = supervisorStatus(view);
  const inDocker = !view.writable && view.keys.claude === null && view.keys["openai-compatible"] === null;
  const [statusHead, ...statusParts] = status.text.split(". ");
  const statusRest = statusParts.join(". ");
  const chosenModel = picked === "codex" ? codexModel.trim() || null : selected;
  const canSubmit = shown.canSave && !saving && (picked === "codex" || Boolean(selected));

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setSaveError("");
    try {
      const response = await fetch(`${apiOrigin}/api/supervisor/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: picked, model: chosenModel }),
      });
      setView(await readJson<SettingsView>(response));
      onToast("Settings saved.");
    } catch (error) {
      setSaveError((error as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <PageHead title="Settings" lede="Which AI the supervisor in Plan & review uses." />
      {inDocker && (
        <div className="panel notice-panel" role="status">
          <strong>Settings are read-only in Docker. Change them with the ctrlplane CLI on the host.</strong>
          <p>
            The container&apos;s files are read-only, and Claude and OpenAI-compatible need the host keychain, which the
            container cannot read.
          </p>
        </div>
      )}
      <div className="pg-two">
        <section className="pg-box" aria-labelledby="st-sup">
          <div className="pg-detail-head">
            <h2 id="st-sup">Supervisor</h2>
          </div>
          <dl className="pg-facts">
            <dt>Provider</dt>
            <dd>{shown.providerLabel}</dd>
            <dt>Model</dt>
            <dd>{view.model ? <code>{view.model}</code> : view.provider === "codex" ? "Codex's default" : "None"}</dd>
            <dt>Status</dt>
            <dd>
              <span className={status.good ? "pg-good" : "pg-warn"}>{statusHead}</span>
              {statusRest && `. ${statusRest}`}
            </dd>
          </dl>

          <form className="st-form" aria-labelledby="st-change" onSubmit={save}>
            <h3 id="st-change">Change provider or model</h3>
            <fieldset className="pg-q" disabled={!shown.canSave}>
              <legend>Provider</legend>
              <p>Keys and the base URL are set in the terminal, not here.</p>
              {CHOICES.map((choice) => (
                <label className="pg-choice" key={choice.value}>
                  <input
                    type="radio"
                    name="provider"
                    value={choice.value}
                    checked={picked === choice.value}
                    onChange={() => setPicked(choice.value)}
                  />
                  <span className="st-choice-text">
                    {choice.title}
                    <small>{choice.note}</small>
                  </span>
                </label>
              ))}
            </fieldset>

            {picked === "codex" ? (
              <div className="st-model">
                <label className="pg-field" htmlFor="st-model-input">
                  Model
                </label>
                <input
                  className="st-input"
                  id="st-model-input"
                  type="text"
                  value={codexModel}
                  disabled={!shown.canSave}
                  spellCheck={false}
                  autoComplete="off"
                  aria-describedby="st-model-input-help"
                  onChange={(event) => setCodexModel(event.target.value)}
                />
                <p className="st-help" id="st-model-input-help">
                  The name you would pass to <code>codex -m</code>. Leave empty for Codex&apos;s default.
                </p>
              </div>
            ) : (
              <div className="st-model">
                <label className="pg-field" htmlFor="st-model-select">
                  Model
                </label>
                <select
                  className="st-select"
                  id="st-model-select"
                  value={selected}
                  disabled={!shown.canSave || shown.modelOptions.length === 0}
                  aria-describedby="st-model-help"
                  onChange={(event) => setSelected(event.target.value)}
                >
                  {shown.modelOptions.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
                <p className="st-help" id="st-model-help">
                  {modelsError ? (
                    <span className="pg-warn">{modelsError}</span>
                  ) : models ? (
                    "From the provider's model list."
                  ) : (
                    "Loading the provider's model list…"
                  )}
                </p>
              </div>
            )}

            {picked === "openai-compatible" && (
              <div className="st-base">
                <span className="pg-field">Base URL</span>
                <code>{view.baseUrl ?? "Not set"}</code>
                <p className="st-help">Read-only here. To change it, run:</p>
                <div className="st-cmd-only">
                  <CopyCommand
                    command={BASE_URL_COMMAND}
                    label="Copy the command to change the base URL"
                    onCopy={onCopy}
                  />
                </div>
              </div>
            )}

            <div className="pg-form-foot">
              <span>
                {saveError ? (
                  <span className="pg-warn">{saveError}</span>
                ) : inDocker ? (
                  "Saving is off in Docker."
                ) : shown.canSave ? (
                  "The next plan or review uses it. No restart needed."
                ) : (
                  shown.reason
                )}
              </span>
              <button type="submit" className="ov-btn pg-primary" disabled={!canSubmit}>
                {saving ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        </section>

        <div className="st-col">
          <section className="pg-box st-keys" aria-labelledby="st-keys">
            <div className="pg-detail-head">
              <h2 id="st-keys">API keys</h2>
            </div>
            <dl className="pg-facts">
              {shown.keyRows.map((row) => (
                <Fragment key={row.provider}>
                  <dt>{PROVIDER_LABEL[row.provider]}</dt>
                  <dd>
                    Key saved:{" "}
                    {row.label === "Yes" ? (
                      <span className="pg-good">Yes</span>
                    ) : row.label === "Not readable" ? (
                      <>
                        <span className="pg-warn">Not readable</span>. There is no keychain in the container.
                      </>
                    ) : (
                      <>
                        <span className="pg-warn">No</span>.
                        {row.provider === "openai-compatible" && " Optional for local servers such as Ollama."} To save
                        one, run:
                      </>
                    )}
                    {row.showCommand && (
                      <CopyCommand
                        command={`ctrlplane supervisor set-key ${row.provider}`}
                        label={`Copy the command to save ${row.provider === "claude" ? "a Claude" : "an OpenAI-compatible"} key`}
                        onCopy={onCopy}
                      />
                    )}
                  </dd>
                </Fragment>
              ))}
              <dt>Codex CLI</dt>
              <dd>No key needed. Codex uses its own sign-in.</dd>
            </dl>
            <p className="st-keys-note">Keys are stored in your system keychain and never pass through this page.</p>
          </section>

          <section className="pg-box pg-howto" aria-labelledby="st-sent">
            <h2 id="st-sent">What is sent</h2>
            <p>
              Claude and OpenAI-compatible providers receive your plan text and the git diff of the picked project.
              Codex reads the repo itself.
            </p>
          </section>
        </div>
      </div>
    </>
  );
}
