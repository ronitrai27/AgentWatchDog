import Link from "next/link";
import { Brand, type BrandId } from "@/components/setup/brand";
import type { SetupState } from "@/lib/models";

/** What was chosen in the setup guide. Changing it reopens that step. */
export function Workspace({ setup }: { setup: SetupState }) {
  const rows: {
    step: "repo" | "sandbox";
    icon: BrandId;
    label: string;
    value: string | null;
  }[] = [
    {
      step: "repo",
      icon: "github",
      label: "Connected repository",
      value: setup.repo,
    },
    {
      step: "sandbox",
      icon: "docker",
      label: "Sandbox",
      value: setup.sandbox && "Docker",
    },
  ];

  return (
    <ul className="divide-y divide-ink/20 border-b border-ink/20">
      {rows.map(({ step, icon, label, value }) => (
        <li key={step} className="flex items-center gap-3.5 py-5">
          <Brand id={icon} size={24} />
          <div className="min-w-0 flex-1 text-[13px]">
            <p className="font-medium text-ink">{label}</p>
            <p className="truncate text-ink-muted" title={value ?? undefined}>
              {value ?? "Not chosen"}
            </p>
          </div>
          <Link
            href={`/home?setup=${step}`}
            aria-label={`${value ? "Change" : "Choose"} ${label.toLowerCase()}`}
            className="btn btn-secondary h-7 shrink-0 px-2.5"
          >
            {value ? "Change" : "Choose"}
          </Link>
        </li>
      ))}
    </ul>
  );
}
