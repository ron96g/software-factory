import { canCallTools, type RecordedToolTurns } from "../ports/index.ts";

export class DefaultRecordedToolTurns implements RecordedToolTurns {
  async complete(input: Parameters<RecordedToolTurns["complete"]>[0]) {
    const { model, transcript, agent, step, turnId } = input;
    if (!canCallTools(model.client)) throw new Error("model does not support tool calling");
    const started = Date.now();
    await transcript.record({
      role: "note", author: { type: "system", id: "tool-loop" }, content: `Model request: ${model.provider}/${model.model}`,
      meta: { step, turnId, model: model.model },
    });
    const reply = await model.client.completeWithTools({ messages: input.messages, tools: input.tools, tier: model.tier });
    await transcript.record({
      role: "assistant", author: { type: "agent", id: agent },
      content: reply.text ?? (reply.toolCalls.length ? "" : "(empty)"),
      meta: { step, turnId, latencyMs: Date.now() - started, model: model.model, toolCalls: reply.toolCalls.map((c) => c.name), final: input.finalText !== false && !reply.toolCalls.length && !!reply.text?.trim() },
    });
    return reply;
  }

  async invoke(input: Parameters<RecordedToolTurns["invoke"]>[0]): Promise<string> {
    const { call, tool, transcript, agent, step, turnId } = input;
    await transcript.record({ role: "tool-call", author: { type: "agent", id: agent }, content: JSON.stringify(call.arguments), meta: { tool: call.name, step, turnId } });
    let result: string;
    try {
      result = tool ? await tool.invoke(call.arguments) : `error: unknown or disallowed tool "${call.name}"`;
    } catch (e) {
      result = `error: ${e instanceof Error ? e.message : String(e)}`;
    }
    await transcript.record({ role: "tool-result", author: { type: "system", id: "tool-loop" }, content: result, meta: { tool: call.name, step, turnId } });
    return result;
  }
}
