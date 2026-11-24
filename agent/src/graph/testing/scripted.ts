// A chat model that answers from a script, for tests and for trying the UI without a key.
// It is a real LangChain chat model, so the graph cannot tell it from a provider.
import {
  BaseChatModel,
  type BaseChatModelParams,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  type BaseMessage,
} from "@langchain/core/messages";
import { ChatGenerationChunk, type ChatResult } from "@langchain/core/outputs";

export type ScriptStep = {
  thinking?: string;
  text?: string;
  toolCalls?: { name: string; args?: Record<string, unknown>; id?: string }[];
  /** Wait this long before answering (to test stop and time limits). */
  delayMs?: number;
  /** Fail instead of answering. */
  error?: Error;
  /** Fail after some text was already streamed. */
  errorAfterText?: Error;
  finishReason?: string;
  usage?: { input_tokens: number; output_tokens: number };
};

export type Responder = (
  messages: BaseMessage[],
  callIndex: number,
) => ScriptStep | Promise<ScriptStep>;

const pieces = (text: string, size: number) => {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
};

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });

export class ScriptedChatModel extends BaseChatModel {
  /** Every list of messages the model was asked about, for assertions. */
  readonly seen: BaseMessage[][] = [];
  /** The tools it was told about. */
  boundTools: unknown[] = [];
  private calls = 0;

  constructor(
    private readonly script: Responder | ScriptStep[],
    params: BaseChatModelParams = {},
  ) {
    super(params);
  }

  _llmType() {
    return "scripted";
  }

  bindTools(tools: unknown[]) {
    this.boundTools = tools;
    return this;
  }

  private async next(messages: BaseMessage[]): Promise<ScriptStep> {
    this.seen.push(messages);
    const index = this.calls++;
    return Array.isArray(this.script)
      ? (this.script[index] ??
          (this.script[this.script.length - 1] as ScriptStep))
      : this.script(messages, index);
  }

  async _generate(messages: BaseMessage[]): Promise<ChatResult> {
    const step = await this.next(messages);
    if (step.error) throw step.error;
    const message = new AIMessage({
      content: step.text ?? "",
      tool_calls: (step.toolCalls ?? []).map((c, i) => ({
        id: c.id ?? `call_${this.calls}_${i}`,
        name: c.name,
        args: c.args ?? {},
        type: "tool_call" as const,
      })),
    });
    return { generations: [{ message, text: step.text ?? "" }] };
  }

  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: { signal?: AbortSignal },
  ): AsyncGenerator<ChatGenerationChunk> {
    const step = await this.next(messages);
    if (step.delayMs) await sleep(step.delayMs, options.signal);
    if (step.error) throw step.error;

    if (step.thinking) {
      for (const part of pieces(step.thinking, 12)) {
        yield new ChatGenerationChunk({
          text: "",
          message: new AIMessageChunk({
            content: [{ type: "reasoning", reasoning: part }],
          }),
        });
      }
    }
    for (const part of pieces(step.text ?? "", 9)) {
      yield new ChatGenerationChunk({
        text: part,
        message: new AIMessageChunk({ content: part }),
      });
    }
    if (step.errorAfterText) throw step.errorAfterText;

    const calls = (step.toolCalls ?? []).map((c, i) => ({
      id: c.id ?? `call_${this.calls}_${i}`,
      name: c.name,
      args: JSON.stringify(c.args ?? {}),
      index: i,
    }));
    yield new ChatGenerationChunk({
      text: "",
      message: new AIMessageChunk({
        content: "",
        tool_call_chunks: calls.map((c) => ({
          ...c,
          type: "tool_call_chunk" as const,
        })),
        response_metadata: {
          finish_reason:
            step.finishReason ?? (calls.length > 0 ? "tool_calls" : "stop"),
        },
        usage_metadata: {
          input_tokens: step.usage?.input_tokens ?? 100,
          output_tokens: step.usage?.output_tokens ?? 20,
          total_tokens:
            (step.usage?.input_tokens ?? 100) +
            (step.usage?.output_tokens ?? 20),
        },
      }),
    });
  }
}
