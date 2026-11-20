import { NextResponse } from "next/server";
import {
  appUrl,
  encodeSession,
  SESSION_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { createJudgeUser, recordAudit } from "@/lib/users";

// Quick Judge Mode: no GitHub and no credentials. Every visit creates a new
// user (random id, name "User") that lives in our database like any other.
export async function GET() {
  let user: Awaited<ReturnType<typeof createJudgeUser>>;
  try {
    user = await createJudgeUser();
  } catch {
    return NextResponse.redirect(appUrl("/auth?error=db"));
  }

  await recordAudit({
    userId: user.id,
    actor: `user:${user.id}`,
    type: "auth.sign_in",
    data: { mode: "judge", login: user.login },
  });

  const response = NextResponse.redirect(appUrl("/auth/callback"));
  response.cookies.set(
    SESSION_COOKIE,
    encodeSession({
      mode: "demo",
      uid: user.id,
      login: user.login,
      name: "User",
      avatar: null,
      installations: [],
    }),
    sessionCookieOptions,
  );
  return response;
}
