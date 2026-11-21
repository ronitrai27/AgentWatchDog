import { randomBytes, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { gh, installUrl } from "@/lib/github-app";
import {
  appUrl,
  encodeSession,
  SESSION_COOKIE,
  STATE_COOKIE,
  sessionCookieOptions,
} from "@/lib/session";
import { recordAudit, upsertGithubUser } from "@/lib/users";

type TokenResponse = { access_token?: string; error?: string };
type GithubUser = {
  id: number;
  login: string;
  name: string | null;
  /** Only the public email; Rox does not request the email permission. */
  email: string | null;
  avatar_url: string | null;
};

function sameState(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function fail(reason: string) {
  const response = NextResponse.redirect(appUrl(`/auth?error=${reason}`));
  response.cookies.delete({ name: STATE_COOKIE, path: "/api/auth/github" });
  return response;
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  if (params.get("error")) return fail("denied");

  const code = params.get("code");
  const state = params.get("state");
  const cookieState = request.headers
    .get("cookie")
    ?.split(/;\s*/)
    .find((part) => part.startsWith(`${STATE_COOKIE}=`))
    ?.slice(STATE_COOKIE.length + 1);

  // CSRF check: the state must match the one we set in this browser.
  if (!code || !state || !cookieState || !sameState(state, cookieState)) {
    return fail("state");
  }

  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (!clientId || !clientSecret) return fail("not_configured");

  try {
    const tokenResponse = await fetch(
      "https://github.com/login/oauth/access_token",
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: appUrl("/api/auth/github/callback").toString(),
        }),
        cache: "no-store",
      },
    );
    const token = (await tokenResponse.json()) as TokenResponse;
    if (!token.access_token) return fail("token");

    // The user token is used here only to learn who they are and which
    // installations they own. It is never stored.
    const user = await gh<GithubUser>("/user", { token: token.access_token });
    const { installations } = await gh<{ installations: { id: number }[] }>(
      "/user/installations?per_page=100",
      { token: token.access_token },
    );

    // Save the person in our database (created on first sign-in, refreshed after).
    let saved: Awaited<ReturnType<typeof upsertGithubUser>>;
    try {
      saved = await upsertGithubUser({
        githubId: user.id,
        login: user.login,
        name: user.name,
        email: user.email,
        avatarUrl: user.avatar_url,
      });
    } catch {
      return fail("db");
    }
    await recordAudit({
      userId: saved.id,
      actor: `user:${saved.id}`,
      type: "auth.sign_in",
      data: {
        mode: "github",
        login: saved.login,
        installations: installations.length,
      },
    });

    const session = encodeSession({
      mode: "github",
      uid: saved.id,
      login: saved.login,
      name: saved.name,
      email: saved.email,
      avatar: saved.avatar_url,
      installations: installations.map((item) => item.id),
    });

    // Nothing installed yet: send them to GitHub's install page. GitHub
    // returns here again with the new installation after they choose repos.
    // Otherwise, the loading page runs and then lands on /home.
    let destination: URL | string = appUrl("/auth/callback");
    let newState: string | null = null;
    if (installations.length === 0) {
      newState = randomBytes(16).toString("hex");
      destination = installUrl(newState);
    }

    const response = NextResponse.redirect(destination);
    response.cookies.set(SESSION_COOKIE, session, sessionCookieOptions);
    if (newState) {
      response.cookies.set(STATE_COOKIE, newState, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/api/auth/github",
        maxAge: 600,
      });
    } else {
      response.cookies.delete({ name: STATE_COOKIE, path: "/api/auth/github" });
    }
    return response;
  } catch {
    return fail("github");
  }
}
