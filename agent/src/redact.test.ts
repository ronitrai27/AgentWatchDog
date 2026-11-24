import assert from "node:assert/strict";
import { test } from "node:test";
import { REDACTED, redactText, redactValue } from "./redact";

const SECRETS = [
  "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789",
  "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
  "AIzaSyA-abcdefghijklmnopqrstuvwxyz012345",
  "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  "xoxb-1234567890-abcdefghij",
  "Bearer abcdefghijklmnopqrstuvwxyz0123456789",
  "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop",
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
];

test("removes keys and tokens from text", () => {
  for (const secret of SECRETS) {
    const out = redactText(`before ${secret} after`);
    assert.ok(
      !out.includes(secret.slice(0, 24)),
      `still contains ${secret.slice(0, 12)}`,
    );
    assert.match(out, /before \[redacted\] after/);
  }
});

test("leaves ordinary text alone", () => {
  const text =
    "TypeError in /api/cart/total at src/cart.ts:42, deploy took 3m 52s, sk is short";
  assert.equal(redactText(text), text);
});

test("cleans every string inside nested data and keeps the shape", () => {
  const input = {
    a: "x",
    list: [SECRETS[0], 3, null, { deep: `key=${SECRETS[1]}` }],
    n: 1,
    ok: true,
  };
  const out = redactValue(input);
  assert.equal(out.n, 1);
  assert.equal(out.ok, true);
  assert.equal(out.list[0], REDACTED);
  assert.equal(out.list[1], 3);
  assert.equal(out.list[2], null);
  assert.equal((out.list[3] as { deep: string }).deep, `key=${REDACTED}`);
  assert.ok(
    JSON.stringify(input).includes(SECRETS[0]),
    "the input must not be changed",
  );
});
