// Rox inside this server: one instance, its graph compiled when the server starts
// (see src/instrumentation.ts). Every chat route uses this one.
import { createRoxFromEnv, type Rox } from "@agent/rox";

const shared = globalThis as { rox?: Rox };

export function rox(): Rox {
  shared.rox ??= createRoxFromEnv();
  return shared.rox;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string) => UUID.test(value);
