import { redirect } from "next/navigation";

// People come here to see the agent, not a brochure, so the root is the
// sign-in page. The marketing page lives at /web.
export default function RootPage() {
  redirect("/auth");
}
