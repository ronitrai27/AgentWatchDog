import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { decide, details, validSignature } from "@/lib/github-webhook";

export const dynamic = "force-dynamic";

// GitHub sends the same delivery again if we answer late, with the same id. Remembering the
// last few hundred keeps a retry from being treated as a new event. (A database table replaces
// this when runs start for real.)
const seen = new Set<string>();

/** The Rox user whose setup points at this repository, or null. */
async function roxUser(installation: unknown, repo: string) {
  try {
    const { rows } = await db().query<{ user_id: string }>(
      `SELECT user_id FROM user_setup
        WHERE repo_installation_id = $1 AND lower(repo) = lower($2)`,
      [installation, repo],
    );
    return rows[0]?.user_id ?? null;
  } catch {
    return null;
  }
}

/** Where GitHub (through the relay) tells Rox what happened. For now it only listens and logs. */
export async function POST(request: Request) {
  const secret = process.env.GITHUB_APP_WEBHOOK_SECRET;
  if (!secret)
    return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const body = await request.text();
  const delivery = request.headers.get("x-github-delivery") ?? "";
  const event = request.headers.get("x-github-event") ?? "";
  if (
    !validSignature(body, request.headers.get("x-hub-signature-256"), secret)
  ) {
    console.warn(
      `[webhook] REJECTED ${event || "?"} delivery=${delivery || "?"}: the signature does not match GITHUB_APP_WEBHOOK_SECRET`,
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }
  if (!event || !delivery)
    return NextResponse.json({ error: "bad_request" }, { status: 400 });

  if (seen.has(delivery)) {
    console.log(`[webhook] duplicate ${event} delivery=${delivery}, ignored`);
    return NextResponse.json({ ok: true, duplicate: true });
  }
  seen.add(delivery);
  if (seen.size > 500) seen.delete(seen.values().next().value as string);

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const p = payload as { action?: string };
  const verdict = decide(event, payload);
  const lines = [
    `[webhook] ${event}${p.action ? `.${p.action}` : ""}  delivery=${delivery}`,
    ...details(event, payload).map(([k, v]) => `  ${k.padEnd(14)}${v}`),
    `  ${"decision".padEnd(14)}${verdict.trigger ? `TRIGGER ${verdict.kind}: ${verdict.why}` : `ignored: ${verdict.why}`}`,
  ];
  if (verdict.trigger) {
    const repo = (payload as { repository?: { full_name?: string } }).repository
      ?.full_name;
    const installation = (payload as { installation?: { id?: number } })
      .installation?.id;
    const user = repo ? await roxUser(installation, repo) : null;
    lines.push(
      `  ${"run key".padEnd(14)}${verdict.key}`,
      `  ${"rox user".padEnd(14)}${user ? `matched ${user.slice(0, 8)}` : "none: no Rox user has chosen this repository"}`,
    );
  }
  console.log(`\n${lines.join("\n")}\n`);

  // Answer at once. The work itself will run in the background, never in this request.
  return NextResponse.json(
    { ok: true, event, trigger: verdict.trigger },
    { status: 202 },
  );
}
