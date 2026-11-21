import { cookies } from "next/headers";
import { decodeSession, SESSION_COOKIE, type Session } from "./session-token";

export * from "./session-token";

/** The signed-in user for this request, or null. Server components only. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}
