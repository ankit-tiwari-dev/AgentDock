// The files this repo copies from agentdock-cli, and the one way to update them.
//   node scripts/cli-copies.ts [--cli <dir>] [--ref <git ref>]          check: every copy matches the CLI at <ref>
//   node scripts/cli-copies.ts [--cli <dir>] [--ref <git ref>] --sync   rewrite every copy from the CLI at <ref>
// <dir> defaults to $AGENTDOCK_CLI_DIR, then ../agentdock-cli; <ref> defaults to HEAD of that checkout.
// --root <dir> points at another AgentDock checkout (the tests use a throwaway one).
// Exit 0 all match (or synced), 1 a copy has drifted, 2 the check could not run.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface Copy {
  copy: string;
  source: string;
}

export const COPIES: readonly Copy[] = [
  { copy: "backend/src/redactor.ts", source: "packages/storage/src/redactor.ts" },
  { copy: "backend/src/keychain.ts", source: "packages/cli/src/keychain.ts" },
  { copy: "backend/src/supervisor-config.ts", source: "packages/cli/src/supervisor-config.ts" },
  { copy: "backend/src/token-pricing.ts", source: "packages/core/src/token-pricing.ts" },
  { copy: "backend/tests/fixtures/secret-vectors.json", source: "packages/storage/tests/fixtures/secret-vectors.json" },
  { copy: "backend/tests/fixtures/supervisor.v1.json", source: "packages/cli/tests/fixtures/supervisor.v1.json" },
];

const REPO_ROOT = join(import.meta.dirname, "..");

export function header(source: string, commit: string): string {
  return `// Copied from agentdock-cli ${source} at commit ${commit}. Update it with node scripts/cli-copies.ts --sync, never by hand.\n\n`;
}

/** The copy's content without its header line and the blank line after it, so it can be compared with the source. */
export function body(copyPath: string, text: string): string {
  if (!copyPath.endsWith(".ts") || !text.startsWith("// Copied from agentdock-cli ")) return text;
  return text.slice(text.indexOf("\n") + 1).replace(/^\n/, "");
}

/** A copy must stand alone: anything but a node: built-in would not resolve here. */
export function foreignImports(text: string): string[] {
  return [...text.matchAll(/^import[^;]*?from\s+["']([^"']+)["']/gm)]
    .map((m) => m[1])
    .filter((s) => !s.startsWith("node:"));
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i > -1 ? argv[i + 1] : undefined;
}

export function main(argv: string[]): number {
  const ROOT = resolve(arg(argv, "--root") ?? REPO_ROOT);
  const cli = resolve(arg(argv, "--cli") ?? process.env.AGENTDOCK_CLI_DIR ?? join(ROOT, "..", "agentdock-cli"));
  const ref = arg(argv, "--ref") ?? "HEAD";
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cli, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let commit: string;
  try {
    if (!existsSync(join(cli, "packages"))) throw new Error(`no agentdock-cli checkout at ${cli} (pass --cli <dir>)`);
    commit = git("rev-parse", "--short", `${ref}^{commit}`).trim();
  } catch (error) {
    console.error("cli-copies: " + (error instanceof Error ? error.message.split("\n")[0] : String(error)));
    return 2;
  }
  const sync = argv.includes("--sync");
  const drifted: string[] = [];
  for (const { copy, source } of COPIES) {
    let upstream: string;
    try {
      upstream = normalize(git("show", `${ref}:${source}`));
    } catch {
      console.error(
        `cli-copies: ${source} does not exist in agentdock-cli at ${commit}; update COPIES in scripts/cli-copies.ts`,
      );
      return 2;
    }
    const foreign = copy.endsWith(".ts") ? foreignImports(upstream) : [];
    if (foreign.length) {
      console.error(
        `cli-copies: ${source} imports ${foreign.join(", ")}; a copied file may import only node: built-ins`,
      );
      return 2;
    }
    const target = join(ROOT, copy);
    const current = existsSync(target) ? normalize(readFileSync(target, "utf8")) : "";
    if (body(copy, current) === upstream) continue;
    if (sync) {
      writeFileSync(target, copy.endsWith(".ts") ? header(source, commit) + upstream : upstream);
      console.log(`cli-copies: synced ${copy} from ${source} at ${commit}`);
    } else drifted.push(`${copy} differs from agentdock-cli ${source} at ${commit}`);
  }
  if (drifted.length === 0) {
    if (!sync) console.log(`cli-copies: ${COPIES.length} copies match agentdock-cli at ${commit}`);
    return 0;
  }
  for (const d of drifted) console.error("  " + d);
  console.error("Never edit a copy by hand: change agentdock-cli, then run node scripts/cli-copies.ts --sync.");
  return 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main(process.argv.slice(2));
