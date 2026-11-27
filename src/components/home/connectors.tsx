"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { Brand, type BrandId } from "@/components/setup/brand";

const MAX_LOGOS = 3;

/** "Connectors" pill in the message box, showing up to 3 connected app logos from the DB. */
export function Connectors({ connected }: { connected: BrandId[] }) {
  const logos = connected.slice(0, MAX_LOGOS);

  return (
    <Link
      href="/home/connections"
      className="focusable flex h-8 items-center gap-2 rounded-full border border-ink/25 bg-neutral-100 px-3 text-[13px] font-medium text-ink hover:border-ink/40"
    >
      Connectors
      {logos.length > 0 ? (
        <span className="flex items-center gap-1" aria-hidden="true">
          {logos.map((id) => (
            <Brand key={id} id={id} size={16} />
          ))}
        </span>
      ) : (
        <PlusIcon aria-hidden="true" className="size-4" />
      )}
    </Link>
  );
}
