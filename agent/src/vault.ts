import { createDecipheriv } from "node:crypto";

export type EncryptedSecret = { iv: Buffer; ciphertext: Buffer; tag: Buffer };

/**
 * Decrypts a secret the web app stored (AES-256-GCM, see src/lib/vault.ts). `context` must be
 * the same text it was encrypted with (`<user id>:<provider>`), so a row copied to another
 * user or provider fails here instead of working.
 */
export function decryptSecret(
  secret: EncryptedSecret,
  context: string,
  keyHex: string,
): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32)
    throw new Error("ENCRYPTION_KEY must be 64 hex characters (32 bytes)");
  const decipher = createDecipheriv("aes-256-gcm", key, secret.iv);
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(secret.tag);
  return Buffer.concat([
    decipher.update(secret.ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
