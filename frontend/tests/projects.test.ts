import test from "node:test";
import assert from "node:assert/strict";
import { isForProject, projectFromSearch, projectQuery } from "../src/lib/events.ts";

test("the picked project lives in the address's project parameter", () => {
  assert.equal(projectFromSearch("?project=agentdock"), "agentdock");
  assert.equal(projectFromSearch("?x=1&project=agentdock-2"), "agentdock-2");
  assert.equal(projectFromSearch(""), null);
});

test("requests name the project only when one is picked", () => {
  assert.equal(projectQuery("agentdock-2"), "?project=agentdock-2");
  assert.equal(projectQuery("a b&c"), "?project=a%20b%26c");
  assert.equal(projectQuery(null), "");
});

test("a live message refreshes the page only for the project on screen", () => {
  assert.equal(isForProject({ project: "agentdock" }, "agentdock"), true);
  assert.equal(isForProject({ project: "agentdock-try" }, "agentdock"), false);
  // A message without a project comes from a backend that watches one project.
  assert.equal(isForProject({}, "agentdock"), true);
  assert.equal(isForProject({ project: "agentdock" }, null), true);
});
