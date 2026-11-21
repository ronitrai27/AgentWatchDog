import { NextResponse } from "next/server";
import { appUrl, getSession, SESSION_COOKIE } from "@/lib/session";
import { recordAudit } from "@/lib/users";

// Where a logout may send the person, keyed by the form field `reason`.
// Only these exact values are accepted, so the redirect cannot be steered.
//   real  - a judge clicked "Try live in the real world"
//   judge - a GitHub user clicked "Try Quick Judge Mode"
const DESTINATIONS = {
  real: "/auth?notice=github",
  judge: "/auth?notice=judge",
} as const;

// POST only, so a link on another site cannot sign you out.
export async function POST(request: Request) {
  const form = await request.formData().catch(() => null);
  const value = form?.get("reason");
  const reason = value === "real" || value === "judge" ? value : null;

  const session = await getSession();
  if (session) {
    await recordAudit({
      userId: session.uid,
      actor: `user:${session.uid}`,
      type: "auth.sign_out",
      data: { mode: session.mode, ...(reason ? { reason } : {}) },
    });
  }

  const response = NextResponse.redirect(
    appUrl(reason ? DESTINATIONS[reason] : "/auth"),
    303,
  );
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
