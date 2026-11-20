import { NextResponse } from "next/server";
import { db } from "@/lib/db";

// Used by the sign-in loading page. Reports only yes/no and timing, never
// connection details.
export async function GET() {
  const started = performance.now();
  let database = false;
  try {
    await db().query("SELECT 1");
    database = true;
  } catch {
    // reported below as database: false
  }
  const configured = Boolean(
    process.env.SESSION_SECRET && process.env.GITHUB_APP_ID,
  );
  return NextResponse.json(
    {
      ok: database && configured,
      database,
      configured,
      ms: Math.round(performance.now() - started),
    },
    {
      status: database && configured ? 200 : 503,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
