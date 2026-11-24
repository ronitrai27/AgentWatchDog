"use client";

import { ChevronDownIcon } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

type Chat = { id: string; name: string; updatedAt: string };

/** Event the chat panel fires when a turn ends, so this list refreshes. */
export const CHATS_CHANGED = "rox:chats-changed";

/** "History" in the sidebar: every chat of this user, newest first, names cut to one line. */
export function ChatHistory({ onNavigate }: { onNavigate?: () => void }) {
  const current = useSearchParams().get("chat");
  const [open, setOpen] = useState(true);
  const [chats, setChats] = useState<Chat[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/chat/list", { cache: "no-store" });
      if (!res.ok) throw new Error(String(res.status));
      setChats(((await res.json()) as { chats: Chat[] }).chats);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reload when the selected chat changes
  useEffect(() => {
    void load();
  }, [load, current]);
  useEffect(() => {
    window.addEventListener(CHATS_CHANGED, load);
    return () => window.removeEventListener(CHATS_CHANGED, load);
  }, [load]);

  return (
    <fieldset
      aria-label="History"
      className="mt-5 min-w-0 bg-neutral-50! rounded border border-ink/20 px-1.5 pb-1.5"
    >
      <legend className="mx-auto px-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="focusable flex h-6 items-center gap-1 rounded-md text-[13px] font-semibold text-black"
        >
          History
          <ChevronDownIcon
            aria-hidden="true"
            className={`size-4 transition-transform ${open ? "" : "-rotate-90"}`}
          />
        </button>
      </legend>

      {open && (
        <ul className="h-72 space-y-px overflow-y-scroll [scrollbar-width:thin]">
          {chats?.map((chat) => {
            const active = current === chat.id;
            return (
              <li key={chat.id}>
                <Link
                  href={`/home?chat=${chat.id}`}
                  onClick={onNavigate}
                  title={chat.name}
                  aria-current={active ? "page" : undefined}
                  className={`block h-8 truncate rounded-md px-2 text-[13px] leading-8 text-ink ${
                    active ? "bg-ink/8" : "hover:bg-ink/6"
                  }`}
                >
                  {chat.name}
                </Link>
              </li>
            );
          })}
          {chats?.length === 0 && (
            <li className="px-2 py-1 text-xs text-ink-muted">No chats yet.</li>
          )}
          {chats === null && !failed && (
            <li className="px-2 py-1 text-xs text-ink-muted">Loading…</li>
          )}
          {failed && (
            <li className="px-2 py-1 text-xs text-destructive">
              Could not load the history.
            </li>
          )}
        </ul>
      )}
    </fieldset>
  );
}
