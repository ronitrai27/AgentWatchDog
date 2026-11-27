"use client";

import { SquarePenIcon } from "lucide-react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { ChatPanel } from "@/components/chat/chat-panel";
import type { BrandId } from "@/components/setup/brand";
import type { SetupState } from "@/lib/models";
import { EmptyHome } from "./empty-home";

const FADE = { duration: 0.28, ease: [0.4, 0, 0.2, 1] } as const;

/**
 * Home once setup is finished. No chat open: a welcome, quick insights and the message box.
 * The first message creates the chat, fades this out and opens the conversation.
 */
export function RoxHome({
  setup,
  name,
  connectedApps,
}: {
  setup: SetupState;
  name: string;
  connectedApps: BrandId[];
}) {
  const chatId = useSearchParams().get("chat");
  const first = useRef<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function start(text: string) {
    setBusy(true);
    setProblem(null);
    try {
      const res = await fetch("/api/chat/new", { method: "POST" });
      if (!res.ok) throw new Error(String(res.status));
      const { id } = (await res.json()) as { id: string };
      first.current = { id, text };
      window.history.pushState(null, "", `/home?chat=${id}`);
    } catch {
      setProblem("The chat could not be started. Try again.");
    } finally {
      setBusy(false);
    }
  }

  /** The message that opened this chat, handed over once. */
  const takeFirst = useCallback((id: string) => {
    if (first.current?.id !== id) return null;
    const { text } = first.current;
    first.current = null;
    return text;
  }, []);

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        {chatId ? (
          <motion.div
            key={chatId}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={FADE}
            className="relative"
          >
            <Link
              href="/home"
              title="Start a new chat"
              className="btn btn-secondary -mt-4 mb-2 inline-flex h-8 px-3 text-[13px] sm:-mt-8 lg:fixed lg:left-64 lg:top-18 lg:z-20 lg:m-0"
            >
              <SquarePenIcon aria-hidden="true" className="size-3.5" />
              New
            </Link>
            <div className="mx-auto max-w-[820px]">
              <ChatPanel
                sessionId={chatId}
                takeFirst={takeFirst}
                modelId={setup.orchestrator}
                helperId={setup.subagent}
              />
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="empty"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -12, scale: 0.985 }}
            transition={FADE}
          >
            <EmptyHome
              setup={setup}
              name={name}
              connectedApps={connectedApps}
              busy={busy}
              problem={problem}
              onSend={(text) => void start(text)}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}
