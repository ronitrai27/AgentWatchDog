import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { decodeSession, SESSION_COOKIE } from "@/lib/session-token";

// Runs before any /home page is rendered. No valid, unexpired session means
// no page: the visitor is sent to /auth and any bad cookie is cleared. Pages
// under /home check the session again, so this is one layer of two.
export function proxy(request: NextRequest) {
  const session = decodeSession(request.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  const response = NextResponse.redirect(new URL("/auth", request.url));
  if (request.cookies.has(SESSION_COOKIE)) {
    response.cookies.delete(SESSION_COOKIE);
  }
  return response;
}

export const config = {
  matcher: ["/home", "/home/:path*"],
};
