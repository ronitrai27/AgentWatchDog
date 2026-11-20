import { NextResponse } from "next/server";
import {
  appUrl,
  encodeSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";

// Quick Judge Mode: no GitHub, no keys. The session is the shared "demo" user.
export async function GET() {
  const response = NextResponse.redirect(appUrl("/home"));
  response.cookies.set(
    SESSION_COOKIE,
    encodeSession({
      mode: "demo",
      uid: "demo",
      login: "judge",
      name: "Judge",
      avatar: null,
      installations: [],
    }),
    sessionCookieOptions,
  );
  return response;
}
