"use client";

import { useState } from "react";

/** The user's picture, or their first initial if there is none or it fails to load. */
export function UserAvatar({
  src,
  name,
  size = 32,
}: {
  src: string | null;
  name: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  const initial = (Array.from(name.trim())[0] ?? "?").toUpperCase();
  const box = { width: size, height: size };

  if (!src || failed) {
    return (
      <span
        aria-hidden="true"
        style={{ ...box, fontSize: size * 0.42 }}
        className="grid shrink-0 place-items-center rounded-full bg-ink font-semibold text-paper"
      >
        {initial}
      </span>
    );
  }

  return (
    // biome-ignore lint/performance/noImgElement: small remote avatar, no optimisation needed
    <img
      src={src}
      alt=""
      style={box}
      className="shrink-0 rounded-full object-cover"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
