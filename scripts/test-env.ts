/**
 * Loaded before every test file (`--import` in the test scripts). A server built without injected settings reads
 * process.env, so on a developer's machine a test could otherwise use their supervisor.json and keychain key and
 * start a real, paid model run. Each test process gets an empty CTRLPLANE_HOME and no supervisor switches.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "agentdock-test-home-"));
process.env.CTRLPLANE_HOME = home;
for (const name of [
  "AGENTDOCK_CODEX",
  "AGENTDOCK_CODEX_PATH",
  "AGENTDOCK_IN_CONTAINER",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
]) {
  delete process.env[name];
}
process.on("exit", () => rmSync(home, { recursive: true, force: true }));
