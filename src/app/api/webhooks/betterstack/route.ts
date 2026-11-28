import {
  BETTERSTACK_SECRET_HEADER,
  validBetterStackSecret,
} from "@agent/integrations/betterstack";
import { NextResponse } from "next/server";
import { handleBetterStackWebhook } from "@/lib/webhooks/betterstack";

export const dynamic = "force-dynamic";

/**
 * Where Better Stack's outgoing webhook (registered by Connect Better Stack) sends incident changes.
 * Better Stack does not sign webhooks, so it carries a secret header; then the incident is read back
 * from Better Stack's API before anything is decided (src/lib/webhooks/betterstack.ts).
 */
export async function POST(request: Request) {
  const secret = process.env.BETTERSTACK_WEBHOOK_SECRET?.trim();
  if (!secret)
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  if (
    !validBetterStackSecret(
      request.headers.get(BETTERSTACK_SECRET_HEADER),
      secret,
    )
  ) {
    console.warn(
      "[betterstack] REJECTED: the secret header does not match BETTERSTACK_WEBHOOK_SECRET",
    );
    return NextResponse.json({ error: "bad_secret" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(await request.text());
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  const outcome = await handleBetterStackWebhook(payload);
  return NextResponse.json(
    { ok: true, outcome: outcome.status },
    { status: 202 },
  );
}
