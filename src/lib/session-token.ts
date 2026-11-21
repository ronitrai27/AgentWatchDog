// Everything about the signed session cookie that does not need next/headers,
// so both route handlers and proxy.ts can use it.
import { createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "rox_session";
export const STATE_COOKIE = "rox_oauth_state";
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

export type Session = {
  v: 1;
  mode: "github" | "demo";
  /** The id of the row in our users table. */
  uid: string;
  login: string;
  name: string | null;
  /** GitHub's public email, when there is one. */
  email: string | null;
  avatar: string | null;
  /** GitHub App installation ids the user was verified to own at sign-in. */
  installations: number[];
  /** Expiry, seconds since epoch. */
  exp: number;
};

function secret(): string {
  const value = process.env.SESSION_SECRET;
  if (!value || value.length < 32) {
    throw new Error("SESSION_SECRET must be set to 32 or more characters");
  }
  return value;
}

function sign(data: string): string {
  return createHmac("sha256", secret()).update(data).digest("base64url");
}

export function encodeSession(input: Omit<Session, "v" | "exp">): string {
  const session: Session = {
    ...input,
    v: 1,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
  };
  const body = Buffer.from(JSON.stringify(session)).toString("base64url");
  return `${body}.${sign(body)}`;
}

/** Returns the session if the signature is valid and it has not expired. */
export function decodeSession(token: string | undefined): Session | null {
  if (!token) return null;
  const [body, signature, extra] = token.split(".");
  if (!body || !signature || extra !== undefined) return null;

  try {
    const expected = Buffer.from(sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length) return null;
    if (!timingSafeEqual(expected, actual)) return null;

    const session = JSON.parse(
      Buffer.from(body, "base64url").toString("utf8"),
    ) as Session;
    if (session.v !== 1) return null;
    if (session.exp < Math.floor(Date.now() / 1000)) return null;
    // Cookies made before email existed have no email field.
    return { ...session, email: session.email ?? null };
  } catch {
    return null;
  }
}

export const sessionCookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
  path: "/",
  maxAge: SESSION_TTL_SECONDS,
};

export function appUrl(path: string): URL {
  return new URL(path, process.env.APP_URL ?? "http://localhost:3000");
}
