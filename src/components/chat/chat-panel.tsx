"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import { CHATS_CHANGED } from "@/components/chat-history";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  buildTurns,
  chatReducer,
  initialChat,
  isRunning,
} from "@/lib/chat-model";
import type { ModelId } from "@/lib/models";
import { Composer } from "./composer";
import { AssistantTurn, UserTurn } from "./turns";

/**
 * One conversation with Rox. It follows the chat as a live stream and sends what the person
 * types. Rox only works when the person has written something.
 */
export function ChatPanel({
  sessionId,
  takeFirst,
  modelId,
  helperId,
}: {
  sessionId: string;
  /** The message typed on the empty Home page, if this chat was opened by it. */
  takeFirst: (sessionId: string) => string | null;
  modelId: ModelId | null;
  helperId: ModelId | null;
}) {
  const [chat, dispatch] = useReducer(chatReducer, initialChat);
  const [reconnecting, setReconnecting] = useState(false);
  const [draft, setDraft] = useState("");
  const [focusSignal, setFocusSignal] = useState(0);
  const [sendProblem, setSendProblem] = useState<string | null>(null);
  const lastSeq = useRef(0);
  lastSeq.current = chat.lastSeq;

  // Follow the chat. On a dropped connection, reconnect from the last event seen.
  useEffect(() => {
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    let failures = 0;

    const connect = () => {
      source = new EventSource(
        `/api/chat/${sessionId}/stream?after=${lastSeq.current}`,
      );
      const on = (
        name: string,
        handler: (data: Record<string, unknown>) => void,
      ) =>
        source?.addEventListener(name, (e) => {
          try {
            handler(JSON.parse((e as MessageEvent).data));
          } catch {
            // a malformed message is skipped, never fatal
          }
        });
      on("event", (data) => {
        failures = 0;
        dispatch({ type: "event", event: data as never });
      });
      on("delta", (d) =>
        dispatch({
          type: "delta",
          turnId: String(d.turnId),
          channel: d.channel === "thinking" ? "thinking" : "text",
          text: String(d.text ?? ""),
        }),
      );
      on("turn", (d) =>
        dispatch({
          type: "turn",
          turnId: String(d.turnId),
          status: d.status as never,
        }),
      );
      on("ready", (d) => {
        failures = 0;
        setReconnecting(false);
        dispatch({ type: "ready", running: d.running === true });
      });
      source.onerror = () => {
        source?.close();
        if (closed) return;
        failures++;
        setReconnecting(true);
        timer = setTimeout(
          connect,
          Math.min(1000 * 2 ** Math.min(failures, 4), 15_000),
        );
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      source?.close();
    };
  }, [sessionId]);

  const running = isRunning(chat);
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running)
      window.dispatchEvent(new Event(CHATS_CHANGED));
    wasRunning.current = running;
  }, [running]);
  const turns = buildTurns(chat);
  const lastUserText = [...turns]
    .reverse()
    .find((t) => t.user && !t.user.pending)?.user?.text;

  async function send(text: string) {
    const body = text.trim();
    if (!body) return;
    setSendProblem(null);
    dispatch({ type: "sent", text: body, at: new Date().toISOString() });
    setDraft("");
    try {
      const res = await fetch(`/api/chat/${sessionId}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: body }),
      });
      if (res.ok) return;
      dispatch({ type: "sendFailed" });
      setDraft(body);
      setSendProblem(
        res.status === 409
          ? "Rox is still working on your last message. Wait for it to finish, or press stop."
          : res.status === 503
            ? "Rox could not start. Check the server log, then try again."
            : "The message could not be sent. Try again.",
      );
    } catch {
      dispatch({ type: "sendFailed" });
      setDraft(body);
      setSendProblem(
        "The message could not be sent. Check the connection and try again.",
      );
    }
  }

  // The message that opened this chat.
  const sendFirst = useRef(send);
  sendFirst.current = send;
  useEffect(() => {
    const text = takeFirst(sessionId);
    if (text) void sendFirst.current(text);
  }, [sessionId, takeFirst]);

  async function stop() {
    await fetch(`/api/chat/${sessionId}/stop`, { method: "POST" }).catch(
      () => {},
    );
  }

  return (
    <TooltipProvider>
      <section
        aria-label="Chat with Rox"
        className="-mt-8 sm:-mt-12 -mb-24 sm:-mb-28 flex h-[calc(100svh-3.5rem)] min-h-[28rem] flex-col pt-6 pb-5"
      >
        <MessageScrollerProvider autoScroll defaultScrollPosition="end">
          <MessageScroller className="flex-1 font-rox">
            <MessageScrollerViewport
              aria-label="Conversation with Rox"
              className="[scrollbar-gutter:auto]! [scrollbar-width:none]! [&::-webkit-scrollbar]:hidden!"
            >
              <MessageScrollerContent className="gap-7 pb-6 pt-2">
                {turns.map((turn) => (
                  <MessageScrollerItem key={turn.key} messageId={turn.key}>
                    <div className="flex flex-col gap-7">
                      {turn.user && (
                        <UserTurn
                          text={turn.user.text}
                          at={turn.user.at}
                          pending={turn.user.pending}
                          onEdit={(text) => {
                            setDraft(text);
                            setFocusSignal((n) => n + 1);
                          }}
                        />
                      )}
                      {(turn.blocks.length > 0 || turn.status === "running") &&
                        !turn.user?.pending && (
                          <AssistantTurn
                            turn={turn}
                            onRetry={
                              turn.user && lastUserText && !running
                                ? () =>
                                    void send(turn.user?.text ?? lastUserText)
                                : undefined
                            }
                          />
                        )}
                      {turn.user?.pending && (
                        <AssistantTurn turn={{ ...turn, user: null }} />
                      )}
                    </div>
                  </MessageScrollerItem>
                ))}
                {turns.length === 0 && chat.ready && (
                  <p className="text-[15px] text-ink-soft">
                    No messages in this chat yet.
                  </p>
                )}
              </MessageScrollerContent>
            </MessageScrollerViewport>
            <MessageScrollerButton />
          </MessageScroller>
        </MessageScrollerProvider>

        <div className="shrink-0 pt-3">
          {reconnecting && (
            <output className="mb-2 block px-2 text-[12px] text-ink-muted">
              Connection lost. Reconnecting…
            </output>
          )}
          {chat.note && (
            <output className="mb-2 block px-2 text-[12px] text-ink-muted">
              {chat.note}
            </output>
          )}
          {sendProblem && (
            <p role="alert" className="mb-2 px-2 text-[12px] text-destructive">
              {sendProblem}
            </p>
          )}
          <Composer
            value={draft}
            onChange={setDraft}
            onSend={() => void send(draft)}
            onStop={() => void stop()}
            running={running}
            disabled={reconnecting}
            placeholder="Message Rox"
            modelId={modelId}
            helperId={helperId}
            focusSignal={focusSignal}
          />
        </div>
      </section>
    </TooltipProvider>
  );
}
