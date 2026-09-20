import {
  AssistantMessageFrameEncoder,
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageFrame,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai';

/**
 * Host side: turn one assistant stream into compact, replayable frames.
 *
 * Every `AssistantMessageEvent` carries `partial`, which is the *shared live*
 * message object, not an event-time snapshot. Sending the raw event list across
 * the worker channel therefore repeats the whole response once per delta - a
 * quadratic payload that eventually makes JSON.stringify throw
 * "Invalid string length" and kills the daemon. The frames keep only the block
 * offsets and deltas needed to rebuild the same live stream.
 */
export async function encodeAssistantStream(events: AsyncIterable<AssistantMessageEvent> | Iterable<AssistantMessageEvent>) {
  const encoder = new AssistantMessageFrameEncoder();
  const frames: AssistantMessageFrame[] = [];
  for await (const event of events) {
    const frame = encoder.encode(event);
    if (frame) frames.push(frame);
  }
  return frames;
}

function terminalEvent(settlement: AssistantMessage): AssistantMessageEvent {
  if (settlement.stopReason === 'error' || settlement.stopReason === 'aborted') {
    return { type: 'error', reason: settlement.stopReason, error: settlement };
  }
  if (settlement.stopReason === 'pending') {
    throw new Error('Assistant stream settled without a terminal stop reason');
  }
  return { type: 'done', reason: settlement.stopReason, message: settlement };
}

/**
 * Worker side: rebuild the live events from compact frames.
 *
 * `partial` must be one shared, mutated message exactly like a provider stream,
 * because the agent loop stores that reference in its context and copies it for
 * each update. Frames never carry terminal settlement; it is passed separately
 * so the caller can persist it.
 */
export function* replayAssistantStream(frames: Iterable<AssistantMessageFrame>, settlement: AssistantMessage): Generator<AssistantMessageEvent> {
  let partial: AssistantMessage | undefined;
  const live = () => {
    if (!partial) throw new Error('Assistant frames are missing their start frame');
    return partial;
  };
  const blockAt = (index: number) => {
    const block = live().content[index];
    if (!block) throw new Error(`Assistant frames reference missing content block ${index}`);
    return block;
  };
  const textAt = (index: number): TextContent => {
    const block = blockAt(index);
    if (block.type !== 'text') throw new Error(`Assistant frames expect a text block at ${index}`);
    return block;
  };
  const thinkingAt = (index: number): ThinkingContent => {
    const block = blockAt(index);
    if (block.type !== 'thinking') throw new Error(`Assistant frames expect a thinking block at ${index}`);
    return block;
  };
  const toolCallAt = (index: number): ToolCall => {
    const block = blockAt(index);
    if (block.type !== 'toolCall') throw new Error(`Assistant frames expect a tool call at ${index}`);
    return block;
  };
  // Tool-call arguments stream as raw JSON text, so the replay accumulates the
  // same text instead of re-serializing partially parsed arguments.
  const toolJson = new Map<number, string>();

  for (const frame of frames) {
    switch (frame.type) {
      case 'start':
        partial = structuredClone(frame.partial);
        yield { type: 'start', partial: live() };
        break;
      case 'text_start':
        live().content[frame.contentIndex] = structuredClone(frame.content);
        yield { type: 'text_start', contentIndex: frame.contentIndex, partial: live() };
        break;
      case 'text_delta':
        textAt(frame.contentIndex).text += frame.delta;
        yield { type: 'text_delta', contentIndex: frame.contentIndex, delta: frame.delta, partial: live() };
        break;
      case 'text_end': {
        const block = textAt(frame.contentIndex);
        block.text = frame.content;
        if (frame.textSignature === undefined) delete block.textSignature;
        else block.textSignature = frame.textSignature;
        yield { type: 'text_end', contentIndex: frame.contentIndex, content: frame.content, partial: live() };
        break;
      }
      case 'thinking_start':
        live().content[frame.contentIndex] = structuredClone(frame.content);
        yield { type: 'thinking_start', contentIndex: frame.contentIndex, partial: live() };
        break;
      case 'thinking_delta':
        thinkingAt(frame.contentIndex).thinking += frame.delta;
        yield { type: 'thinking_delta', contentIndex: frame.contentIndex, delta: frame.delta, partial: live() };
        break;
      case 'thinking_end': {
        const block = thinkingAt(frame.contentIndex);
        block.thinking = frame.content;
        if (frame.thinkingSignature === undefined) delete block.thinkingSignature;
        else block.thinkingSignature = frame.thinkingSignature;
        if (frame.redacted === undefined) delete block.redacted;
        else block.redacted = frame.redacted;
        yield { type: 'thinking_end', contentIndex: frame.contentIndex, content: frame.content, partial: live() };
        break;
      }
      case 'toolcall_start':
        live().content[frame.contentIndex] = structuredClone(frame.toolCall);
        toolJson.set(frame.contentIndex, '');
        yield { type: 'toolcall_start', contentIndex: frame.contentIndex, partial: live() };
        break;
      case 'toolcall_checkpoint':
        toolJson.set(frame.contentIndex, frame.json);
        toolCallAt(frame.contentIndex).arguments = parseStreamingJson(frame.json);
        yield { type: 'toolcall_delta', contentIndex: frame.contentIndex, delta: '', partial: live() };
        break;
      case 'toolcall_delta': {
        const next = `${toolJson.get(frame.contentIndex) ?? ''}${frame.delta}`;
        toolJson.set(frame.contentIndex, next);
        toolCallAt(frame.contentIndex).arguments = parseStreamingJson(next);
        yield { type: 'toolcall_delta', contentIndex: frame.contentIndex, delta: frame.delta, partial: live() };
        break;
      }
      case 'toolcall_end': {
        const toolCall: ToolCall = {
          type: 'toolCall',
          id: frame.id,
          name: frame.name,
          arguments: frame.arguments,
          ...(frame.thoughtSignature === undefined ? {} : { thoughtSignature: frame.thoughtSignature }),
          ...(frame.namespace === undefined ? {} : { namespace: frame.namespace }),
        };
        live().content[frame.contentIndex] = toolCall;
        toolJson.delete(frame.contentIndex);
        yield { type: 'toolcall_end', contentIndex: frame.contentIndex, toolCall, partial: live() };
        break;
      }
    }
  }
  yield terminalEvent(settlement);
}
