"use client";

import { useEffect, useState } from "react";

type Props = {
  message: string;
  /** Hide after this many milliseconds. Omit to keep it until the page changes. */
  duration?: number;
  /** Show a spinner, for work that is still in progress. */
  busy?: boolean;
};

/** A small notice fixed to the top centre of the screen. */
export function Toast({ message, duration, busy = false }: Props) {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!duration) return;
    const timer = setTimeout(() => setVisible(false), duration);
    return () => clearTimeout(timer);
  }, [duration]);

  if (!visible) return null;

  return (
    <output
      aria-live="polite"
      className="toast fixed left-1/2 top-5 z-50 flex items-center gap-2.5 rounded-full bg-ink px-4 py-2.5 text-sm text-paper shadow-lg"
    >
      {busy && (
        <svg
          viewBox="0 0 24 24"
          className="size-4 animate-spin"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="12"
            cy="12"
            r="9"
            stroke="currentColor"
            strokeOpacity="0.3"
            strokeWidth="3"
          />
          <path
            d="M21 12a9 9 0 0 0-9-9"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span>{message}</span>
    </output>
  );
}
