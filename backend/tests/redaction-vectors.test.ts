import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { redactSecrets } from "../src/redactor.ts";

test("the shared secret vectors redact the same way as in the CLI", () => {
  const file = JSON.parse(readFileSync(new URL("./fixtures/secret-vectors.json", import.meta.url), "utf8")) as {
    vectors: Array<{
      name: string;
      input: string;
      expected: string;
      secret: { prefix: string; body: string; repeat: number };
    }>;
  };
  assert.ok(file.vectors.length >= 5);
  for (const v of file.vectors) {
    const secret = v.secret.prefix + v.secret.body.repeat(v.secret.repeat);
    assert.equal(
      redactSecrets(v.input.replaceAll("{secret}", secret)).sanitized,
      v.expected.replaceAll("{secret}", secret),
      v.name,
    );
  }
});
