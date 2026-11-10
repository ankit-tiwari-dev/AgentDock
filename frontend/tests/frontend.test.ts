import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

test("Frontend Dashboard HTML is structured and contains all 5 control views", () => {
  const htmlPath = join(import.meta.dirname, "..", "public", "index.html");
  assert.equal(existsSync(htmlPath), true);

  const html = readFileSync(htmlPath, "utf8");

  // Verify Title and Brand
  assert.ok(html.includes("AgentDock"));
  assert.ok(html.includes("Control Plane"));

  // Verify all 5 Views / Tabs exist
  assert.ok(html.includes('id="view-overview"'));
  assert.ok(html.includes('id="view-wizard"'));
  assert.ok(html.includes('id="view-stream"'));
  assert.ok(html.includes('id="view-verifier"'));
  assert.ok(html.includes('id="view-diff"'));

  // Verify Socratic Product Wizard components
  assert.ok(html.includes('id="wizardPromptInput"'));
  assert.ok(html.includes('id="clarificationBox"'));
  assert.ok(html.includes('id="lockedSpecBox"'));
  assert.ok(html.includes('submitProductPrompt()'));
  assert.ok(html.includes('lockSpecification()'));

  // Verify Two-Tier Verification components
  assert.ok(html.includes("Tier 1: Deterministic Checks"));
  assert.ok(html.includes("Tier 2: Evidence-Backed Criteria Checklist"));
  assert.ok(html.includes("SEMANTIC_VERIFIED"));

  // Verify Live WebSocket Handler
  assert.ok(html.includes("new WebSocket"));
  assert.ok(html.includes("timelineContainer"));
});

