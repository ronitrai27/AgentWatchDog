import { writeBrief } from "@agent/brief";
import { NextResponse } from "next/server";
import { getInsights, type Insights } from "@/lib/insights";
import { getSession } from "@/lib/session";

// The same facts give the same line, so the model is asked only when something changed.
const written = new Map<string, { facts: string; line: string }>();

/** The line without a model, from the same facts. */
function plain(i: Insights): string {
  const bad = i.health?.pulls.find((p) => p.checks === "failing");
  if (i.health?.checks === "failing")
    return `Look into the failing checks on ${i.health.branch}`;
  if (bad) return `Look into the failing pull request #${bad.number}`;
  if (i.health?.pulls[0])
    return `Review pull request #${i.health.pulls[0].number} ${i.health.pulls[0].title}`;
  const missing = i.security?.find((c) => !c.ok);
  if (missing) return `The repository is missing ${missing.label}`;
  if (i.activity?.last) return `Latest commit: ${i.activity.last}`;
  return "";
}

/** The one line under "Welcome" on Home. Empty when there is nothing to say. */
export async function GET() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    const i = await getInsights(session.uid, session.mode === "demo");
    if (i.github !== "connected") return NextResponse.json({ line: "" });
    const facts = {
      commitsIn14Days: i.activity?.total,
      latestCommit: i.activity?.last,
      checks: i.health,
      pullRequests: i.pulls,
      securityBasics: i.security,
    };
    const key = JSON.stringify(facts);
    const known = written.get(session.uid);
    if (known?.facts === key) return NextResponse.json({ line: known.line });
    const line = await writeBrief(facts).catch(() => null);
    if (line) written.set(session.uid, { facts: key, line });
    return NextResponse.json({ line: line ?? plain(i) });
  } catch {
    return NextResponse.json({ error: "unavailable" }, { status: 503 });
  }
}
