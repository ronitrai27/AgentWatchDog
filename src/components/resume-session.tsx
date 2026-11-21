"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Toast } from "./toast";

/**
 * Shown instead of the sign-in page when the visitor already has a valid
 * session: a loading toast, then straight to /home.
 */
export function ResumeSession({ name }: { name: string }) {
  const router = useRouter();

  useEffect(() => {
    const timer = setTimeout(() => router.replace("/home"), 900);
    return () => clearTimeout(timer);
  }, [router]);

  return (
    <main className="grid min-h-svh place-items-center bg-paper">
      <Toast message={`Welcome back, ${name}. Opening Home…`} busy />
      <Image
        src="/brand/rox-logo.png"
        alt="Rox"
        width={56}
        height={56}
        className="rounded-xl"
        priority
      />
    </main>
  );
}
