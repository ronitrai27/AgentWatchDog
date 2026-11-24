import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { createSession } from "@/lib/sessions";

/** Starts an empty chat. The agent names it after the first message. */
export async function POST() {
  const session = await getSession();
  if (!session)
    return NextResponse.json({ error: "signed_out" }, { status: 401 });
  try {
    const chat = await createSession(session.uid, "New chat");
    return NextResponse.json({ id: chat.id });
  } catch {
    return NextResponse.json({ error: "database" }, { status: 503 });
  }
}
