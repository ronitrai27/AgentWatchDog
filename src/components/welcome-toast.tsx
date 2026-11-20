"use client";

import { useEffect } from "react";
import { Toast } from "./toast";

/** Greets the user once after sign-in, then removes ?welcome=1 from the URL. */
export function WelcomeToast({ name }: { name: string }) {
  useEffect(() => {
    window.history.replaceState(null, "", "/home");
  }, []);

  return <Toast message={`Welcome, ${name}`} duration={4000} />;
}
