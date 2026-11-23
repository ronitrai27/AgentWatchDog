import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { listRepos } from "@/lib/setup";

/** The repositories the signed-in GitHub user can pick in the setup guide. */
export async function GET() {
  const session = await getSession();
  if (!session || session.mode !== "github") {
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  }
  try {
    const repos = await listRepos(session);
    return NextResponse.json(
      { repos: repos.map(({ name, private: hidden }) => ({ name, hidden })) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "github" }, { status: 502 });
  }
}
