import { NextResponse } from "next/server";
import { appUrl, SESSION_COOKIE } from "@/lib/session";

// POST only, so a link on another site cannot sign you out.
export async function POST() {
  const response = NextResponse.redirect(appUrl("/auth"), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
