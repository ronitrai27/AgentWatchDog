import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  decide,
  details,
  summarize,
  validSignature,
} from "@/lib/github-webhook";
import { reportTarget } from "@/lib/report-connections";
import { startPrRun } from "@/lib/rox-runs";
import { recordEvent, replacedBecause, short } from "@/lib/webhook-ledger";

export const dynamic = "force-dynamic";

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

/** Where GitHub (through the relay) tells Rox what happened. For now it records and logs. */
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

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const p = payload as {
    action?: string;
    repository?: { full_name?: string };
    installation?: { id?: number };
    sender?: { login?: string };
  };
  const repo = p.repository?.full_name ?? null;
  const verdict = decide(event, payload);
  const summary = summarize(event, payload);
  const userId =
    verdict.trigger && repo ? await roxUser(p.installation?.id, repo) : null;
  const entry = {
    delivery,
    event,
    action: p.action ?? null,
    repo,
    installation: p.installation?.id ?? null,
    sender: p.sender?.login ?? null,
    summary,
    verdict,
    userId,
  };

  let result: Awaited<ReturnType<typeof recordEvent>>;
  try {
    result = await recordEvent(entry);
  } catch (error) {
    console.error(
      `[webhook] could not record ${event} delivery=${delivery}: ${error instanceof Error ? error.message : error}`,
    );
    // GitHub shows the delivery as failed, and it can be sent again from the App's settings.
    return NextResponse.json({ error: "ledger_unavailable" }, { status: 503 });
  }

  const name = `${event}${p.action ? `.${p.action}` : ""}`;
  if (result.duplicate) {
    console.log(
      `\n[webhook] ${name} delivery=${delivery}\n  DUPLICATE: GitHub sent this delivery again. Already recorded, nothing done.\n`,
    );
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const lines = [
    `[webhook] ${name}  delivery=${delivery}`,
    ...details(event, payload).map(([k, v]) => `  ${k.padEnd(14)}${v}`),
    `  ${"listened".padEnd(14)}${verdict.trigger ? "TRUE" : "false"}`,
    `  ${"decision".padEnd(14)}${verdict.trigger ? `${verdict.kind}: ${verdict.why}` : `ignored: ${verdict.why}`}`,
  ];
  if (verdict.trigger) {
    lines.push(
      `  ${"run key".padEnd(14)}${verdict.key}`,
      `  ${"rox user".padEnd(14)}${userId ? `matched ${userId.slice(0, 8)}` : "none: no Rox user has chosen this repository"}`,
    );
    for (const r of result.replaced)
      lines.push(
        `  ${"SUPERSEDED".padEnd(14)}${r.prNumber ? `PR #${r.prNumber} ` : ""}${short(r.sha)} on ${r.branch ?? "-"} (delivery ${r.delivery}) after ${r.ageSeconds}s: ${replacedBecause(entry)}`,
      );
    if (result.replaced.length === 0)
      lines.push(
        `  ${"superseded".padEnd(14)}nothing, no older ${verdict.kind} was active`,
      );
  }
  console.log(`\n${lines.join("\n")}\n`);

  // A pull request into the default branch of a repository a Rox user chose: start the fix run
  // in Temporal. Not awaited: the work runs in the background, never in this request.
  if (verdict.trigger && verdict.kind === "pr_to_default" && userId && repo) {
    const p = (
      payload as {
        pull_request?: {
          number?: number;
          title?: string;
          head?: { sha?: string; ref?: string };
          base?: { sha?: string };
        };
      }
    ).pull_request;
    if (p?.number && p.head?.sha && p.head.ref && p.base?.sha) {
      const run = {
        repo,
        pr: p.number,
        head: p.head.sha,
        base: p.base.sha,
        prBranch: p.head.ref,
        title: p.title ?? null,
      };
      void reportTarget(userId)
        .catch(() => null)
        .then((report) => startPrRun({ ...run, report }))
        .then(
          (s) =>
            console.log(
              `[webhook] started Rox for PR #${run.pr}: ${s.workflowId} run ${s.runId}`,
            ),
          (error) =>
            console.error(
              `[webhook] could not start Rox for PR #${run.pr} (are Temporal and pnpm temporal:worker running?): ${error instanceof Error ? error.message : error}`,
            ),
        );
    }
  }

  // Answer at once. The work itself runs in the background, never in this request.
  return NextResponse.json(
    {
      ok: true,
      event,
      listened: verdict.trigger,
      superseded: result.replaced.length,
    },
    { status: 202 },
  );
}
