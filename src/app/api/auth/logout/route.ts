import { NextResponse } from "next/server";
import { appUrl, getSession, SESSION_COOKIE } from "@/lib/session";
import { recordAudit } from "@/lib/users";

// POST only, so a link on another site cannot sign you out.
export async function POST() {
  const session = await getSession();
  if (session) {
    await recordAudit({
      userId: session.uid,
      actor: `user:${session.uid}`,
      type: "auth.sign_out",
      data: { mode: session.mode },
    });
  }
  const response = NextResponse.redirect(appUrl("/auth"), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
