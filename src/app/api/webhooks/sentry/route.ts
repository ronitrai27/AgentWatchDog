import { validSentrySignature } from "@agent/integrations/sentry";
import { NextResponse } from "next/server";
import { logSentryWebhook } from "@/lib/webhooks/sentry";

export const dynamic = "force-dynamic";

/**
 * Where Sentry's integration webhooks arrive (issue events, alert-rule actions, installation).
 * Verifies the signature, then hands the event to src/lib/webhooks/sentry.ts. For now it only logs.
 */
export async function POST(request: Request) {
  const secret = process.env.SENTRY_CLIENT_SECRET;
  if (!secret)
    return NextResponse.json({ error: "not_configured" }, { status: 503 });

  const body = await request.text();
  const resource = request.headers.get("sentry-hook-resource") ?? "";
  if (
    !validSentrySignature(
      body,
      request.headers.get("sentry-hook-signature"),
      secret,
    )
  ) {
    console.warn(
      `[sentry] REJECTED ${resource || "?"}: the signature does not match SENTRY_CLIENT_SECRET`,
    );
    return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "bad_json" }, { status: 400 });
  }

  await logSentryWebhook(resource, request.headers, payload);
  return NextResponse.json({ ok: true }, { status: 202 });
}
