import Image from "next/image";
import { Brand } from "@/components/setup/brand";
import { findModel, type SetupState } from "@/lib/models";

function Fact({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-x-4 gap-y-0.5 py-2 sm:grid-cols-[168px_minmax(0,1fr)]">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

function ModelName({ id }: { id: SetupState["orchestrator"] }) {
  const model = findModel(id);
  if (!model) return <>Not chosen</>;
  return (
    <span className="inline-flex items-center gap-1.5 align-middle">
      <Brand id={model.provider} size={16} />
      {model.label}
    </span>
  );
}

/**
 * What the home page shows once setup is finished. Rox's first message is
 * written by the web app from what the user chose; no model writes it. The
 * agent service does not exist yet, so the message says so and the box below
 * stays off until it can be answered.
 */
export function RoxChat({
  setup,
  isJudge,
}: {
  setup: SetupState;
  isJudge: boolean;
}) {
  return (
    <section
      aria-label="Chat with Rox"
      className="flex min-h-[calc(100svh-10rem)] flex-col"
    >
      <div className="flex-1">
        <div className="flex gap-3">
          <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-ink">
            <Image
              src="/brand/rox-logo.svg"
              alt=""
              width={32}
              height={32}
              unoptimized
              className="size-[70%] object-contain"
            />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-ink">Rox</p>
            <div className="mt-1 text-[15px] leading-relaxed text-ink">
              <p>
                Hi, I'm Rox, your senior AI SRE agent. Once my service is
                running I will watch{" "}
                <span className="font-medium">{setup.repo}</span> around the
                clock: investigate a production error, reproduce it in a
                sandbox, write and test a fix, and open a pull request for you
                to merge. I never merge or deploy myself.
              </p>
              <p className="mt-3">Here is where things stand right now.</p>

              <dl className="mt-2 divide-y divide-ink/10 rounded-lg border border-ink/15 bg-white px-3.5 text-[13px]">
                <Fact label="Watching">
                  Not yet. The agent service is not running.
                </Fact>
                <Fact label="Issues and pull requests">None to show.</Fact>
                <Fact label="Connections">
                  {isJudge
                    ? "None. Quick Demo Mode runs them in test mode."
                    : "None connected yet. They are listed in the Setup Guide."}
                </Fact>
                <Fact label="Models">
                  <ModelName id={setup.orchestrator} /> plans the run
                  {setup.subagent !== setup.orchestrator && (
                    <>
                      , <ModelName id={setup.subagent} /> does the work
                    </>
                  )}
                </Fact>
                <Fact label="Sandbox">
                  {setup.sandbox === "docker" ? "Docker" : "Not chosen"}
                </Fact>
              </dl>
            </div>
          </div>
        </div>
      </div>

      <form className="sticky bottom-4 mt-10" aria-label="Message Rox">
        <div className="flex items-end gap-2 rounded-xl border border-ink/15 bg-white p-2 shadow-[0_1px_2px_rgb(43_58_48/0.06)]">
          <textarea
            disabled
            rows={1}
            aria-label="Message to Rox"
            placeholder="Chat turns on when the agent service is running"
            className="max-h-40 min-h-9 flex-1 resize-none bg-transparent px-2 py-2 text-[14px] text-ink placeholder:text-muted disabled:cursor-not-allowed"
          />
          <button type="submit" disabled className="btn btn-primary h-9">
            Send
          </button>
        </div>
      </form>
    </section>
  );
}
