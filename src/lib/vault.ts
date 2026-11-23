import { createCipheriv, randomBytes } from "node:crypto";

function encryptionKey(): Buffer {
  const key = Buffer.from(process.env.ENCRYPTION_KEY ?? "", "hex");
  if (key.length !== 32) {
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  }
  return key;
}

/**
 * Encrypts a secret with AES-256-GCM. `context` is authenticated but not
 * stored, so a row copied to another user or provider cannot be decrypted.
 * There is no decrypt here on purpose: the web app never reads secrets back.
 */
export function encryptSecret(plain: string, context: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  return { iv, ciphertext, tag: cipher.getAuthTag() };
}
