import { expect, test } from 'vitest';
import {
  parseStreamingJson,
  type AssistantMessage,
  type AssistantMessageEvent,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
} from '@earendil-works/pi-ai';
import { encodeAssistantStream, replayAssistantStream } from '../../src/runtime/assistant-stream-frames.ts';

type ProgressEvent = Exclude<AssistantMessageEvent, { type: 'done' | 'error' }>;

function emptyMessage(): AssistantMessage {
  return {
    role: 'assistant',
    content: [],
    api: 'openai-completions',
    provider: 'graph-openai',
    model: 'local',
    usage: {
      input: 12, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'pending',
    timestamp: 1_700_000_000_000,
  };
}

/**
 * Provider-shaped stream: one shared partial message mutated per delta and
 * pulled lazily, exactly like the host consuming a real AssistantMessageEventStream.
 */
function liveStream(deltas: number) {
  const partial = emptyMessage();
  const collected: AssistantMessageEvent[] = [];
  const snapshots: string[] = [];
  const finished: { settlement?: AssistantMessage } = {};
  const record = (event: ProgressEvent) => {
    collected.push(event);
    snapshots.push(JSON.stringify(event.partial));
    return event;
  };

  async function* stream() {
    yield record({ type: 'start', partial });

    partial.content[0] = { type: 'thinking', thinking: '' };
    yield record({ type: 'thinking_start', contentIndex: 0, partial });
    for (const chunk of ['plan ', 'the ', 'edit']) {
      (partial.content[0] as ThinkingContent).thinking += chunk;
      yield record({ type: 'thinking_delta', contentIndex: 0, delta: chunk, partial });
    }
    (partial.content[0] as ThinkingContent).thinking = 'plan the edit';
    yield record({ type: 'thinking_end', contentIndex: 0, content: 'plan the edit', partial });

    partial.content[1] = { type: 'text', text: '' };
    yield record({ type: 'text_start', contentIndex: 1, partial });
    for (let index = 0; index < deltas; index += 1) {
      const chunk = `chunk${index % 10} `;
      (partial.content[1] as TextContent).text += chunk;
      yield record({ type: 'text_delta', contentIndex: 1, delta: chunk, partial });
    }
    const text = (partial.content[1] as TextContent).text;
    yield record({ type: 'text_end', contentIndex: 1, content: text, partial });

    partial.content[2] = { type: 'toolCall', id: 'call-1', name: 'read', arguments: {} };
    yield record({ type: 'toolcall_start', contentIndex: 2, partial });
    let json = '';
    for (const chunk of ['{"path"', ':"a.txt"', '}']) {
      json += chunk;
      (partial.content[2] as ToolCall).arguments = parseStreamingJson(json);
      yield record({ type: 'toolcall_delta', contentIndex: 2, delta: chunk, partial });
    }
    (partial.content[2] as ToolCall).arguments = { path: 'a.txt' };
    yield record({ type: 'toolcall_end', contentIndex: 2, toolCall: partial.content[2] as ToolCall, partial });

    const settlement: AssistantMessage = { ...structuredClone(partial), stopReason: 'toolUse' };
    finished.settlement = settlement;
    // The raw protocol would ship this terminal event alongside everything else.
    collected.push({ type: 'done', reason: 'toolUse', message: settlement });
  }
  return { stream: stream(), collected, snapshots, finished };
}

test('compact frames replay the identical live stream', async () => {
  const { stream, collected, snapshots, finished } = liveStream(40);
  const frames = await encodeAssistantStream(stream);
  // Snapshot each replayed step as it is produced: the live partial keeps
  // growing, exactly like the provider's own stream.
  const replayed: AssistantMessageEvent[] = [];
  const replayedSnapshots: string[] = [];
  for (const event of replayAssistantStream(frames, finished.settlement!)) {
    replayed.push(event);
    replayedSnapshots.push('partial' in event ? JSON.stringify(event.partial) : JSON.stringify(event));
  }

  expect(replayed).toHaveLength(collected.length);
  expect(replayed.map(event => event.type)).toEqual(collected.map(event => event.type));
  // Every step must carry the same live partial the provider produced, because
  // the agent loop stores that reference as the assistant message in context.
  expect(replayedSnapshots.slice(0, -1)).toEqual(snapshots);
  expect(replayed.at(-1)).toEqual({ type: 'done', reason: 'toolUse', message: finished.settlement });
  expect(replayed.find(event => event.type === 'toolcall_end')).toMatchObject({
    toolCall: { id: 'call-1', name: 'read', arguments: { path: 'a.txt' } },
  });
});

test('compact frames stay linear in the response length', async () => {
  const { stream, collected } = liveStream(400);
  const frames = await encodeAssistantStream(stream);
  const compact = JSON.stringify(frames).length;
  const raw = JSON.stringify(collected).length;
  // The raw event list repeats the whole partial message on every delta.
  expect(raw).toBeGreaterThan(200_000);
  expect(compact * 5).toBeLessThan(raw);
});

test('a settled error replays as a terminal error event', async () => {
  const { stream, collected, finished } = liveStream(3);
  const frames = await encodeAssistantStream(stream);
  const failed: AssistantMessage = { ...structuredClone(finished.settlement!), stopReason: 'error', errorMessage: 'provider failed' };
  const replayed = [...replayAssistantStream(frames, failed)];
  expect(replayed).toHaveLength(collected.length);
  expect(replayed.at(-1)).toEqual({ type: 'error', reason: 'error', error: failed });
});
