import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { installUrl } from "@/lib/github-app";
import { appUrl, getSession, STATE_COOKIE } from "@/lib/session";

// Sends a signed-in user to GitHub's install page with a fresh CSRF state, so
// the callback can verify the return trip.
export async function GET() {
  const session = await getSession();
  if (!session || session.mode !== "github") {
    return NextResponse.redirect(appUrl("/auth"));
  }

  const state = randomBytes(16).toString("hex");
  const response = NextResponse.redirect(installUrl(state));
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/github",
    maxAge: 600,
  });
  return response;
}
