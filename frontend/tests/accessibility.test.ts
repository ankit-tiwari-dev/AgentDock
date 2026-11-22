import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const componentsDir = join(import.meta.dirname, "..", "src", "components");

type Button = { file: string; tag: string; body: string };

/** Every `<button ...>...</button>` in the components; the opening tag ends at the first `>` outside braces and quotes. */
function buttons(): Button[] {
  const found: Button[] = [];
  for (const file of readdirSync(componentsDir).filter((name) => name.endsWith(".tsx"))) {
    const text = readFileSync(join(componentsDir, file), "utf8");
    let from = 0;
    for (;;) {
      const start = text.indexOf("<button", from);
      if (start === -1) break;
      let depth = 0;
      let quote = "";
      let end = start;
      for (; end < text.length; end++) {
        const ch = text[end];
        if (quote) {
          if (ch === quote) quote = "";
        } else if (ch === '"' || ch === "'" || ch === "`") quote = ch;
        else if (ch === "{") depth++;
        else if (ch === "}") depth--;
        else if (ch === ">" && depth === 0) break;
      }
      const close = text.indexOf("</button>", end);
      found.push({ file, tag: text.slice(start, end + 1), body: text.slice(end + 1, close) });
      from = close;
    }
  }
  return found;
}

/** What a sighted user reads on the button, with icons, comments and screen-reader-only hints taken out. */
function visibleContent(body: string): string {
  return body
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/<svg[\s\S]*?<\/svg>/g, "")
    .replace(/<span className="sr-only">[\s\S]*?<\/span>/g, "")
    .replace(/<[A-Z]\w*Icon\s*\/>/g, "")
    .replace(/\{paused \? <PlayIcon \/> : <PauseIcon \/>\}/g, "")
    .trim();
}

test("the scanner finds the buttons it must check", () => {
  const files = new Set(buttons().map((button) => button.file));
  for (const file of ["overview.tsx", "timeline.tsx", "settings.tsx", "page-parts.tsx", "rules.tsx"]) {
    assert.ok(files.has(file), file);
  }
});

test("regression: a button with visible text is named by that text, so its accessible name starts with it (WCAG 2.5.3)", () => {
  for (const { file, tag, body } of buttons()) {
    if (!visibleContent(body)) continue;
    // An aria-label replaces the visible text as the name; Lighthouse flags it when the two differ.
    assert.equal(/\baria-label(ledby)?=/.test(tag), false, `${file}: ${tag}`);
  }
});

test("regression: a screen-reader hint on a button comes after its visible text", () => {
  for (const { file, body } of buttons()) {
    const hint = body.indexOf('className="sr-only"');
    if (hint === -1) continue;
    const after = body.slice(body.indexOf("</span>", hint) + "</span>".length).trim();
    assert.equal(after, "", `${file}: ${body.trim()}`);
  }
});
