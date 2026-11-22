import test from "node:test";
import assert from "node:assert/strict";
import {
  type SettingsView,
  modelListFor,
  settingsView,
  supervisorLabel,
  supervisorStatus,
} from "../src/lib/settings.ts";

const view = (over: Partial<SettingsView> = {}): SettingsView => ({
  provider: "claude",
  model: "claude-opus-5-5",
  baseUrl: null,
  source: "config",
  keys: { claude: true, "openai-compatible": false },
  writable: true,
  ...over,
});

test("Key saved reads yes or no per API provider, and the current model stays selectable when the list lacks it", () => {
  const v = settingsView(view(), {
    models: ["claude-sonnet-5-5", "claude-haiku-5-5"],
    freeText: false,
    current: "claude-opus-5-5",
  });
  assert.equal(v.providerLabel, "Claude");
  assert.deepEqual(v.modelOptions, ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]);
  assert.deepEqual(v.keyRows, [
    { provider: "claude", label: "Yes", showCommand: false },
    { provider: "openai-compatible", label: "No", showCommand: true },
  ]);
  assert.equal(v.canSave, true);
  assert.equal(v.reason, undefined);
  // The current model is listed once, and a failed list still offers it.
  assert.deepEqual(
    settingsView(view(), { models: ["claude-opus-5-5"], freeText: false, current: "claude-opus-5-5" }).modelOptions,
    ["claude-opus-5-5"],
  );
  assert.deepEqual(settingsView(view(), null).modelOptions, []);
  assert.equal(settingsView(view({ provider: null, model: null, source: "none" }), null).providerLabel, "None");
});

test("when settings are not writable, save is disabled and the reason is shown", () => {
  const docker =
    "Read-only container. Change the supervisor with ctrlplane supervisor on the host. API providers need the host keychain, so they do not run in Docker.";
  const v = settingsView(
    view({ keys: { claude: null, "openai-compatible": null }, writable: false, writableReason: docker }),
    null,
  );
  assert.equal(v.canSave, false);
  assert.equal(v.reason, docker);
  assert.deepEqual(
    v.keyRows.map((r) => [r.label, r.showCommand]),
    [
      ["Not readable", false],
      ["Not readable", false],
    ],
  );
});

test("the status says Ready only when a click would start a model call, and why not otherwise", () => {
  assert.deepEqual(supervisorStatus(view()), { good: true, text: "Ready" });
  assert.deepEqual(supervisorStatus(view({ keys: { claude: false, "openai-compatible": false } })), {
    good: false,
    text: "Not ready. No Claude key saved. Run: ctrlplane supervisor set-key claude",
  });
  assert.deepEqual(supervisorStatus(view({ keys: { claude: null, "openai-compatible": null }, writable: false })), {
    good: false,
    text: "Not ready. The container cannot read the host keychain, so the Claude key is not available.",
  });
  // A local server may need no key.
  assert.deepEqual(supervisorStatus(view({ provider: "openai-compatible", model: "llama3.2" })), {
    good: true,
    text: "Ready",
  });
  assert.deepEqual(supervisorStatus(view({ provider: "codex", model: null })), { good: true, text: "Ready" });
  const problem =
    "The supervisor settings file cannot be used (json). Rewrite it with: ctrlplane supervisor use <provider> <model>";
  assert.deepEqual(supervisorStatus(view({ provider: null, model: null, configProblem: problem })), {
    good: false,
    text: `Not ready. ${problem}`,
  });
  assert.deepEqual(supervisorStatus(view({ provider: null, model: null, source: "none" })), {
    good: false,
    text: "Off. Plan & review uses the built-in supervisor.",
  });
});

test("the Plan & review line names provider and model, and says the built-in supervisor is used when none is set", () => {
  assert.equal(
    supervisorLabel({ provider: "claude", model: "claude-opus-5-5", keySaved: true, ready: true }),
    "Supervisor: Claude, claude-opus-5-5",
  );
  assert.equal(
    supervisorLabel({ provider: "openai-compatible", model: "llama3.2", keySaved: false, ready: true }),
    "Supervisor: OpenAI-compatible, llama3.2",
  );
  assert.equal(
    supervisorLabel({ provider: "codex", model: null, keySaved: null, ready: true }),
    "Supervisor: Codex, default model",
  );
  assert.equal(supervisorLabel({ provider: null, model: null, keySaved: null, ready: false }), "Supervisor: built-in");
  assert.equal(supervisorLabel(null), "Supervisor: built-in");
});

test("regression: saving does not refetch the model list or reset the picked model", () => {
  const before = view();
  // A save answers with a new settings object; the model list is keyed on the picked provider alone.
  const afterSave = view({ model: "claude-sonnet-5-5" });
  assert.equal(modelListFor("claude", before), "claude");
  assert.equal(modelListFor("claude", afterSave), modelListFor("claude", before));
  const withBothKeys = view({ keys: { claude: true, "openai-compatible": true } });
  assert.equal(modelListFor("openai-compatible", withBothKeys), "openai-compatible");
  // Codex has no list, and nothing is fetched before the settings arrive.
  assert.equal(modelListFor("codex", before), null);
  assert.equal(modelListFor("claude", null), null);
});

test("regression: no model list is requested for a provider without a saved key", () => {
  // The list call uses the key, so without one the backend answers 503 and the page logs an error.
  assert.equal(modelListFor("openai-compatible", view()), null);
  assert.equal(modelListFor("claude", view({ keys: { claude: false, "openai-compatible": false } })), null);
  assert.equal(modelListFor("claude", view({ keys: { claude: null, "openai-compatible": null } })), null);
});
