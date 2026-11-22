import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRefreshQueue } from "../src/lib/refresh-queue.ts";

// A fetcher whose calls finish only when the test says so, in any order.
function controlledFetcher() {
  const calls: { resolve: (value: number) => void; reject: (error: unknown) => void }[] = [];
  const fetcher = () =>
    new Promise<number>((resolve, reject) => {
      calls.push({ resolve, reject });
    });
  return { calls, fetcher };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("regression: a burst of triggers during a slow fetch starts exactly one more fetch", async () => {
  const { calls, fetcher } = controlledFetcher();
  const applied: number[] = [];
  const queue = createRefreshQueue({ fetch: fetcher, apply: (value) => applied.push(value) });
  queue.trigger();
  for (let i = 0; i < 50; i++) queue.trigger();
  assert.equal(calls.length, 1);
  calls[0].resolve(1);
  await settle();
  assert.equal(calls.length, 2);
  for (let i = 0; i < 10; i++) queue.trigger();
  calls[1].resolve(2);
  await settle();
  assert.equal(calls.length, 3);
  calls[2].resolve(3);
  await settle();
  assert.equal(calls.length, 3);
  assert.deepEqual(applied, [1, 2, 3]);
});

test("regression: an answer started before invalidate() is dropped even when it lands last", async () => {
  const { calls, fetcher } = controlledFetcher();
  const applied: number[] = [];
  const queue = createRefreshQueue({ fetch: fetcher, apply: (value) => applied.push(value) });
  queue.trigger();
  queue.invalidate();
  assert.equal(calls.length, 2);
  calls[1].resolve(2);
  await settle();
  calls[0].resolve(1);
  await settle();
  assert.deepEqual(applied, [2]);
  assert.equal(calls.length, 2);
});

test("regression: a failed fetch reports the error and does not wedge the queue", async () => {
  const { calls, fetcher } = controlledFetcher();
  const applied: number[] = [];
  const errors: unknown[] = [];
  let settled = 0;
  const queue = createRefreshQueue({
    fetch: fetcher,
    apply: (value) => applied.push(value),
    onError: (error) => errors.push(error),
    onSettled: () => settled++,
  });
  queue.trigger();
  queue.trigger();
  calls[0].reject(new Error("offline"));
  await settle();
  assert.equal(errors.length, 1);
  assert.equal(calls.length, 2);
  calls[1].resolve(7);
  await settle();
  queue.trigger();
  assert.equal(calls.length, 3);
  assert.deepEqual(applied, [7]);
  assert.equal(settled, 2);
});

test("regression: nothing is applied or fetched after dispose()", async () => {
  const { calls, fetcher } = controlledFetcher();
  const applied: number[] = [];
  const queue = createRefreshQueue({ fetch: fetcher, apply: (value) => applied.push(value) });
  queue.trigger();
  queue.trigger();
  queue.dispose();
  calls[0].resolve(1);
  await settle();
  queue.trigger();
  queue.invalidate();
  assert.equal(calls.length, 1);
  assert.deepEqual(applied, []);
});

test("regression: the dashboard coalesces live refreshes and loads health and projects together", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "..", "src", "components", "dashboard.tsx"), "utf8");
  assert.match(text, /createRefreshQueue\(/);
  assert.match(text, /Promise\.all\(\[\s*fetch\(`\$\{API_ORIGIN\}\/api\/health`/);
  // A new project remounts Sessions, so its picked session resets without an effect.
  assert.match(text, /<Sessions\s+key=\{shownId \?\? ""\}/);
});
