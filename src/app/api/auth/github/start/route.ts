import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";
import { appUrl, STATE_COOKIE } from "@/lib/session";

export async function GET() {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(appUrl("/auth?error=not_configured"));
  }

  // Random value bound to this browser; the callback refuses any mismatch.
  const state = randomBytes(16).toString("hex");

  const authorize = new URL("https://github.com/login/oauth/authorize");
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set(
    "redirect_uri",
    appUrl("/api/auth/github/callback").toString(),
  );
  authorize.searchParams.set("state", state);

  const response = NextResponse.redirect(authorize);
  response.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/api/auth/github",
    maxAge: 600,
  });
  return response;
}
