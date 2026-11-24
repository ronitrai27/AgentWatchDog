// First node of every turn. A stop or a crash can leave the chat with an assistant message that
// asked for tools but never got answers; every provider rejects such a history. Drop the
// half-finished message so the conversation is valid again.
import {
  AIMessage,
  RemoveMessage,
  ToolMessage,
} from "@langchain/core/messages";
import type { RoxStateType } from "../graph";

export async function sanitize(state: RoxStateType) {
  const answered = new Set<string>();
  for (const m of state.messages)
    if (ToolMessage.isInstance(m)) answered.add(m.tool_call_id);

  const remove: RemoveMessage[] = [];
  for (const m of state.messages) {
    if (!AIMessage.isInstance(m) || !m.id) continue;
    const missing = (m.tool_calls ?? []).some(
      (c) => !c.id || !answered.has(c.id),
    );
    if (missing) remove.push(new RemoveMessage({ id: m.id }));
  }
  return remove.length > 0 ? { messages: remove } : {};
}
