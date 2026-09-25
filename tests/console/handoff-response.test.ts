import { afterEach, expect, test } from 'vitest';
import { controlledOpenAIStream, type SendGate } from '../../src/runtime/controlled-openai.ts';
import { guardHandoffResponses } from '../../src/runtime/handoff-response.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { externallyGated, openPiInstance } from '../../src/runtime/pi-instance.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { DatabaseSync } from 'node:sqlite';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { reply } from '../fixtures/models.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

// Structural replay of the September 25 provider response; no production text or credentials.
const handoff = 'I will inspect the failing test.\n\n<analysis>\nLet me chronologically analyze this conversation.\n</analysis>\n\n<summary>\n1. Primary Request and Intent:\nFix the test.\n6. All user messages:\nprivate-history-marker\n7. Pending Tasks:\nFix it.\n8. Current Work:\nStill pending.\n9. Optional Next Step:\nRead the file.\n</summary>';

async function replay(texts: string[], enabled = true) {
  const server = await openaiServer(texts.map(text => ({ chunks: [...text] })));
  cleanup.push(() => server.close());
  let sends = 0;
  let settlements = 0;
  const notices: string[] = [];
  const gate: SendGate = {
    dispatch(_id, _reservation, send) { sends++; return send(); },
    settle() { settlements++; },
  };
  const stream = guardHandoffResponses(controlledOpenAIStream(gate, 'test-key'), {
    enabled: () => enabled,
    onRecovery: status => notices.push(status),
  });
  const events = [];
  const context = { messages: [{ role: 'user' as const, content: 'Fix the failing test.', timestamp: 1 }] };
  for await (const event of await stream(server.model, context, {})) events.push(structuredClone(event));
  return { events, sends, settlements, notices, requests: server.requests, context };
}

test('a handoff in an ordinary response is replaced by one gated correction without leaking its body', async () => {
  const result = await replay([handoff, '已修复并验证。']);
  expect(result.sends).toBe(2);
  expect(result.settlements).toBe(2);
  expect(result.notices).toEqual(['retrying', 'recovered']);
  expect(JSON.stringify(result.events)).not.toContain('private-history-marker');
  expect(result.events.at(-1)).toMatchObject({ type: 'done', message: { content: [{ type: 'text', text: '已修复并验证。' }] } });
  expect(JSON.stringify(result.requests[1])).not.toContain('private-history-marker');
  expect(result.context.messages).toHaveLength(1);
});

test('repeated handoffs stop explicitly instead of succeeding or retrying indefinitely', async () => {
  const result = await replay([handoff, handoff]);
  expect(result.sends).toBe(2);
  expect(result.notices).toEqual(['retrying', 'failed']);
  expect(result.events.at(-1)).toMatchObject({ type: 'error', error: { stopReason: 'error' } });
  expect(JSON.stringify(result.events)).not.toContain('private-history-marker');
});

test.each([
  '工作摘要：测试已完成，下一步提交。',
  '<summary>这是用户要求的摘要。</summary>',
  'Example:\n```xml\n' + handoff + '\n```',
])('ordinary summaries and quoted markup remain unchanged: %s', async text => {
  const result = await replay([text]);
  expect(result.sends).toBe(1);
  expect(result.events.at(-1)).toMatchObject({ type: 'done', message: { content: [{ text }] } });
});

test('formal compaction bypasses the conversational guard', async () => {
  const result = await replay([handoff], false);
  expect(result.sends).toBe(1);
  expect(result.events.at(-1)).toMatchObject({ type: 'done', message: { content: [{ text: handoff }] } });
});

test('cancellation at the handoff boundary remains an abort and does not send a correction', async () => {
  const server = await openaiServer([]);
  cleanup.push(() => server.close());
  const controller = new AbortController();
  let sends = 0;
  const stream = guardHandoffResponses(model => {
    sends++;
    controller.abort();
    const events = createAssistantMessageEventStream();
    events.push({ type: 'done', reason: 'stop', message: reply(model, handoff) });
    return events;
  }, { enabled: () => true, onRecovery() {} });
  let last;
  for await (const event of await stream(server.model, { messages: [] }, { signal: controller.signal })) last = event;
  expect(sends).toBe(1);
  expect(last).toMatchObject({ type: 'error', reason: 'aborted', error: { content: [], stopReason: 'aborted' } });
});

test('a previously persisted bad handoff is excluded from model input without changing stored history', async () => {
  const server = await openaiServer([{ text: '继续修复。' }]);
  cleanup.push(() => server.close());
  const gate: SendGate = { dispatch(_id, _r, send) { return send(); }, settle() {} };
  const bad = {
    role: 'assistant' as const, content: [{ type: 'text' as const, text: handoff }],
    api: server.model.api, provider: server.model.provider, model: server.model.id,
    stopReason: 'stop' as const, timestamp: 1,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const stream = guardHandoffResponses(controlledOpenAIStream(gate, 'test-key'), { enabled: () => true, onRecovery() {} });
  for await (const _event of await stream(server.model, { messages: [bad, { role: 'user', content: 'continue', timestamp: 2 }] }, {})) { /* drain */ }
  expect(JSON.stringify(server.requests)).not.toContain('private-history-marker');
  expect(bad.content[0]!.text).toBe(handoff);
});

test('the correction allowance is shared across requests in the same operation', async () => {
  const server = await openaiServer([{ text: handoff }, { text: '继续。' }, { text: handoff }]);
  cleanup.push(() => server.close());
  const notices: string[] = [];
  const gate: SendGate = { dispatch(_id, _r, send) { return send(); }, settle() {} };
  const stream = guardHandoffResponses(controlledOpenAIStream(gate, 'test-key'), { enabled: () => true, onRecovery: s => notices.push(s) });
  const context = { messages: [{ role: 'user' as const, content: 'Fix it.', timestamp: 1 }] };
  for await (const _event of await stream(server.model, context, {})) { /* drain */ }
  const events = [];
  for await (const event of await stream(server.model, context, {})) events.push(event);
  expect(server.requests).toHaveLength(3);
  expect(notices).toEqual(['retrying', 'recovered', 'failed']);
  expect(events.at(-1)).toMatchObject({ type: 'error' });
});

test('the Pi session continues tools after correction, persists only the valid answer and never repeats a completed tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const server = await openaiServer([
    { tools: [{ id: 'first', name: 'work', arguments: '{}' }] },
    { chunks: [...handoff] },
    { tools: [{ id: 'second', name: 'verify', arguments: '{}' }] },
    { text: '验证完成。' },
  ]);
  cleanup.push(() => server.close());
  let sends = 0;
  let settled = 0;
  const calls: string[] = [];
  const gate: SendGate = { dispatch(_id, _r, send) { sends++; return send(); }, settle() { settled++; } };
  const instance = await openPiInstance({
    binding: { instanceId: 'main', nodeId: 'main', definitionVersion: 'main@1' },
    workspace: root, stateDir: join(root, 'state'), model: server.model, modelRuntime: server.runtime,
    stream: guardHandoffResponses(controlledOpenAIStream(gate, 'test-key'), { enabled: () => true, onRecovery() {} }),
    tools: ['work', 'verify'].map(name => externallyGated({
      name, label: name, description: name, parameters: { type: 'object', properties: {} },
      execute: async () => { calls.push(name); return { content: [{ type: 'text' as const, text: 'done' }], details: {} }; },
    })),
  });
  try {
    await instance.prompt('Fix and verify the test.');
    expect(calls).toEqual(['work', 'verify']);
    expect(sends).toBe(4);
    expect(settled).toBe(4);
    const state = instance.inspect();
    expect(JSON.stringify(state.messages)).not.toContain('private-history-marker');
    expect(await readFile(state.sessionFile, 'utf8')).not.toContain('private-history-marker');
    expect(state.messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ text: '验证完成。' }] });
  } finally { await instance.close(); }
});

test('the production conversation adapter records recovery and publishes only the corrected final reply', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-handoff-conversation-'));
  const server = await openaiServer([{ text: handoff }, { text: '修复已完成。' }]);
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: {
      entries: [{ ...server.model, grade: 'high', credentialId: 'local', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
      apiKey: 'test-key', modelRuntime: server.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  try {
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
    const created = await runtime.conversations.create({ text: '修复测试。', requestId: 'create' });
    await runtime.host.runReady();
    await expect.poll(async () => {
      const view = await runtime.conversations.view(created.conversationId);
      return view.messages.some(m => m.role === 'assistant' && m.text.includes('修复已完成。'));
    }).toBe(true);
    const view = await runtime.conversations.view(created.conversationId);
    expect(JSON.stringify(view.messages)).not.toContain('private-history-marker');
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      const events = db.prepare("SELECT data FROM events WHERE type='session.handoff_response' ORDER BY cursor").all() as { data: string }[];
      expect(events.map(e => JSON.parse(e.data).status)).toEqual(['retrying', 'recovered']);
      expect(db.prepare("SELECT count(*) n FROM invocations WHERE purpose='completion'").get()).toMatchObject({ n: 2 });
    } finally { db.close(); }
  } finally {
    await runtime.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
