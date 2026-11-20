import { redirect } from "next/navigation";
import { StartingAgent } from "@/components/starting-agent";
import { getSession } from "@/lib/session";

// Every sign-in (GitHub or Quick Judge Mode) lands here first. Without a
// session there is nothing to start, so send them back to sign in.
export default async function AuthCallbackPage() {
  const session = await getSession();
  if (!session) redirect("/auth");
  return <StartingAgent />;
}
