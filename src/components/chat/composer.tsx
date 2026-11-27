"use client";

import {
  ArrowUpIcon,
  MicIcon,
  OctagonXIcon,
  PauseIcon,
  SquareIcon,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { Brand } from "@/components/setup/brand";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { findModel, type ModelId } from "@/lib/models";

// The browser's speech recognition. Not in every browser, so it is feature-detected.
type Recognition = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
};
type RecognitionEvent = {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
};
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Dictation into the box. Returns whether it works here, whether it is listening, and a toggle. */
function useDictation(onText: (text: string) => void) {
  const [supported, setSupported] = useState(false);
  const [listening, setListening] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const recognition = useRef<Recognition | null>(null);

  useEffect(() => {
    setSupported(recognitionCtor() !== null);
    return () => recognition.current?.stop();
  }, []);

  const toggle = useCallback(() => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const Ctor = recognitionCtor();
    if (!Ctor) return;
    setProblem(null);
    const next = new Ctor();
    next.continuous = true;
    next.interimResults = false;
    next.lang = navigator.language || "en-US";
    next.onresult = (event) => {
      let said = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result?.isFinal) said += result[0].transcript;
      }
      if (said.trim()) onText(said.trim());
    };
    next.onerror = (event) =>
      setProblem(
        event.error === "not-allowed"
          ? "Microphone access was blocked. Allow it in the browser's site settings."
          : event.error === "no-speech"
            ? null
            : `Voice input stopped: ${event.error}`,
      );
    next.onend = () => setListening(false);
    recognition.current = next;
    try {
      next.start();
      setListening(true);
    } catch {
      setProblem("Voice input could not start.");
    }
  }, [listening, onText]);

  return { supported, listening, problem, toggle };
}

/** The controls of a test run in the sandbox (checks, fix, verify), when one is going. */
export type TestRunControls = {
  onPause: () => void;
  onKill: () => void;
};

/** Pause and kill: shown while Rox works, usable only during a test run, not in plain chat. */
function RunButtons({ run }: { run: TestRunControls | null }) {
  const off = "Only while Rox is testing or fixing a pull request";
  const buttons = [
    {
      label: "Pause",
      icon: <PauseIcon />,
      tip: run
        ? "Pause the run: the current step stops, the sandbox and progress are kept"
        : off,
      onClick: run?.onPause,
      className: "",
    },
    {
      label: "Kill switch",
      icon: <OctagonXIcon />,
      tip: run
        ? "Kill switch: stop everything now and destroy the sandbox"
        : off,
      onClick: run?.onKill,
      className: run ? "text-destructive hover:bg-destructive/10" : "",
    },
  ];
  return buttons.map((b) => (
    <Tooltip key={b.label}>
      <TooltipTrigger
        render={
          <InputGroupButton
            size="icon-sm"
            aria-label={b.label}
            aria-disabled={!run}
            onClick={() => run && b.onClick?.()}
            className={run ? b.className : "cursor-not-allowed opacity-40"}
          />
        }
      >
        {b.icon}
      </TooltipTrigger>
      <TooltipContent>{b.tip}</TooltipContent>
    </Tooltip>
  ));
}

/**
 * The message box. Under the text: the model that answers (its logo), a microphone to dictate,
 * and send. While Rox is working, send becomes stop, next to pause and the kill switch (usable
 * only during a test run). There is no upload button.
 */
export function Composer({
  value,
  onChange,
  onSend,
  onStop,
  running,
  disabled,
  placeholder,
  modelId,
  helperId,
  focusSignal,
  leading,
  testRun = null,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  placeholder: string;
  modelId: ModelId | null;
  helperId: ModelId | null;
  /** Changes when something (Edit) puts text in the box and wants it focused. */
  focusSignal: number;
  /** Shown at the bottom left, for example the connectors. */
  leading?: ReactNode;
  /** Set while a test run is going; without it pause and kill are shown but disabled. */
  testRun?: TestRunControls | null;
}) {
  const area = useRef<HTMLTextAreaElement>(null);
  const main = findModel(modelId);
  const helper = findModel(helperId);
  // Both models the user chose: the one that plans and answers, and the helper if it differs.
  const shown: { model: NonNullable<typeof main>; role: string }[] = [];
  if (main) shown.push({ model: main, role: "plans and answers" });
  if (helper && helper.id !== main?.id)
    shown.push({ model: helper, role: "does the work" });
  const canSend = value.trim().length > 0 && !disabled && !running;
  useEffect(() => {
    if (focusSignal > 0) {
      const el = area.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    }
  }, [focusSignal]);

  const dictate = useDictation(
    useCallback(
      (text: string) =>
        onChange(`${value}${value && !value.endsWith(" ") ? " " : ""}${text}`),
      [value, onChange],
    ),
  );

  return (
    <form
      aria-label="Message Rox"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSend) onSend();
      }}
    >
      <InputGroup className="rounded-xl border-ink/20 bg-white shadow-[0_1px_3px_rgb(43_58_48/0.10)] has-disabled:bg-white has-disabled:opacity-100 has-[[data-slot=input-group-control]:focus-visible]:border-ink/20! has-[[data-slot=input-group-control]:focus-visible]:ring-0! dark:bg-white">
        <InputGroupTextarea
          ref={area}
          value={value}
          rows={2}
          disabled={disabled}
          aria-label="Message to Rox"
          placeholder={placeholder}
          className="max-h-48 min-h-14 px-4 pt-3 text-[15px]"
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (canSend) onSend();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="gap-1 pb-2 pl-2 pr-2">
          {leading}
          <div className="ml-auto flex items-center gap-1">
            {shown.map(({ model, role }) => (
              <Tooltip key={model.id}>
                <TooltipTrigger
                  render={
                    <span
                      role="img"
                      aria-label={`${model.label} ${role}`}
                      className="grid size-8 place-items-center"
                    />
                  }
                >
                  <Brand id={model.provider} size={18} />
                </TooltipTrigger>
                <TooltipContent>
                  {model.label} {role}
                </TooltipContent>
              </Tooltip>
            ))}

            <Tooltip>
              <TooltipTrigger
                render={
                  <InputGroupButton
                    size="icon-sm"
                    aria-label={
                      dictate.listening
                        ? "Stop dictation"
                        : "Dictate with microphone"
                    }
                    aria-pressed={dictate.listening}
                    aria-disabled={!dictate.supported}
                    onClick={() => dictate.supported && dictate.toggle()}
                    className={
                      dictate.listening
                        ? "bg-destructive/10 text-destructive"
                        : dictate.supported
                          ? undefined
                          : "cursor-not-allowed opacity-50"
                    }
                  />
                }
              >
                <MicIcon />
              </TooltipTrigger>
              <TooltipContent>
                {dictate.supported
                  ? dictate.listening
                    ? "Listening… click to stop"
                    : "Dictate"
                  : "Voice input is not supported in this browser"}
              </TooltipContent>
            </Tooltip>

            {running && <RunButtons run={testRun} />}

            {running ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      variant="default"
                      aria-label="Stop"
                      onClick={onStop}
                      className="rounded-full"
                    />
                  }
                >
                  <SquareIcon className="fill-current" />
                </TooltipTrigger>
                <TooltipContent>Stop Rox</TooltipContent>
              </Tooltip>
            ) : (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <InputGroupButton
                      type="submit"
                      size="icon-sm"
                      variant="default"
                      aria-label="Send message"
                      disabled={!canSend}
                      className="rounded-full"
                    />
                  }
                >
                  <ArrowUpIcon />
                </TooltipTrigger>
                <TooltipContent>Send</TooltipContent>
              </Tooltip>
            )}
          </div>
        </InputGroupAddon>
      </InputGroup>
      {dictate.problem && (
        <p role="alert" className="mt-1.5 px-2 text-[12px] text-destructive">
          {dictate.problem}
        </p>
      )}
    </form>
  );
}
