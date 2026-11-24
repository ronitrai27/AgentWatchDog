import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { encryptSecret } from "../../src/lib/vault";
import { decryptSecret } from "./vault";

const keyHex = randomBytes(32).toString("hex");
process.env.ENCRYPTION_KEY = keyHex;

test("decrypts what the web app encrypted", () => {
  const secret = encryptSecret(
    "sk-test-abcdefghijklmnopqrstuvwxyz",
    "user-1:openai",
  );
  assert.equal(
    decryptSecret(secret, "user-1:openai", keyHex),
    "sk-test-abcdefghijklmnopqrstuvwxyz",
  );
});

test("a copied row does not decrypt for another user or provider", () => {
  const secret = encryptSecret("the-key", "user-1:openai");
  assert.throws(() => decryptSecret(secret, "user-2:openai", keyHex));
  assert.throws(() => decryptSecret(secret, "user-1:google", keyHex));
});

test("a tampered or wrongly keyed secret fails", () => {
  const secret = encryptSecret("the-key", "u:p");
  const tampered = {
    ...secret,
    ciphertext: Buffer.from(secret.ciphertext.map((b) => b ^ 1)),
  };
  assert.throws(() => decryptSecret(tampered, "u:p", keyHex));
  assert.throws(() =>
    decryptSecret(secret, "u:p", randomBytes(32).toString("hex")),
  );
  assert.throws(() => decryptSecret(secret, "u:p", "abcd"), /64 hex/);
});
