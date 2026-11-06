import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// An Agent that can only talk to its own session has one way to reach a running
// peer: interrupt it. The product declared two tools for the other way round -
// `conversation_read` and `conversation_write` - and never wired the channel that
// carries them, so no master session was ever offered them; nothing asserted the
// gap. This keeper forces the wiring to exist: a real master turn calls
// `conversation_write`, and a different, real conversation receives the message
// with the sending Agent named.
//
// The proof is a real daemon on real loopback with a scripted provider: the tool
// call and the delivery both have to happen for the assertions to pass.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface ConversationView {
  anchorTaskId?: string;
  messages: { id: string; role: string; text?: string; data?: { source?: { kind?: string; conversationId?: string } } }[];
}

async function view(daemon: { request: (path: string, init?: RequestInit) => Promise<Response> }, id: string) {
  return await (await daemon.request(`/api/conversations/${id}`)).json() as ConversationView;
}

test('a master session hands work to another conversation through its own tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-conversation-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  // The tool call needs the target's real id, so the arguments are built when the
  // request arrives - after the conversation exists.
  let targetId = '';
  let senderId = '';
  // Plans are answered in arrival order, and the target conversation speaks first:
  // its standby turn, then the sender's handoff turn, then the sender's closing
  // answer, then the target answering what it was asked.
  const provider = await openaiServer([
    { text: '待命完毕。', usage: { prompt_tokens: 200, completion_tokens: 6 } },
    {
      tools: [{ id: 'handoff-1', name: 'conversation_write', arguments: () => JSON.stringify({ action: 'send', conversationId: targetId, text: '请汇总当前进度', requestId: 'handoff' }) }],
      usage: { prompt_tokens: 500, completion_tokens: 20 },
    },
    { text: 'A 已经把请求交给另一个会话。', usage: { prompt_tokens: 560, completion_tokens: 15 } },
    { text: 'B 已收到并汇总。', usage: { prompt_tokens: 300, completion_tokens: 12 } },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    access: { mode: 'full' },
    credentials: { local: { secretRef: 'GRAPH_CONVERSATION_TOOLS_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_CONVERSATION_TOOLS_KEY: 'synthetic-only' } });
  cleanup.push(() => daemon.close());

  const targetResponse = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: '待命。', requestId: 'target-conversation' }),
  });
  const targetText = await targetResponse.text();
  expect(targetResponse.status, targetText).toBe(200);
  targetId = (JSON.parse(targetText) as { conversationId: string }).conversationId;

  const senderResponse = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: '把进度交给另一个会话。', requestId: 'sender-conversation' }),
  });
  const senderText = await senderResponse.text();
  expect(senderResponse.status, senderText).toBe(200);
  senderId = (JSON.parse(senderText) as { conversationId: string }).conversationId;

  // Conversation B really received it: the message names the sending Agent, and the
  // target's own model answered it.
  const textOf = async () => (await view(daemon, targetId)).messages.map(message => message.text ?? '').join('\n');
  await expect.poll(textOf, { timeout: 60_000, interval: 250 }).toContain('来自另一个 Agent');
  await expect.poll(textOf, { timeout: 60_000, interval: 250 }).toContain('B 已收到并汇总。');

  const target = await view(daemon, targetId);
  const handoff = target.messages.find(message => (message.text ?? '').includes('来自另一个 Agent'));
  expect(handoff?.text, JSON.stringify(target.messages).slice(0, 3_000)).toContain(senderId);
  expect(handoff?.text).toContain('请汇总当前进度');
  // The delivery is recorded as another Agent, never as the person.
  expect(handoff?.data?.source?.kind).toBe('agent');

  // And the caller's own ledger records the handoff it made.
  const sender = await view(daemon, senderId);
  expect(sender.messages.map(message => message.text ?? '').join('\n')).toContain('A 已经把请求交给另一个会话。');
  const events = await (await daemon.request(`/api/tasks/${sender.anchorTaskId}/events?after=0&limit=500`)).json() as { type?: string; data?: Record<string, unknown> }[];
  const handed = (Array.isArray(events) ? events : []).filter(event => event.type === 'conversation.handed_off');
  expect(handed.length, JSON.stringify(events).slice(0, 2_000)).toBeGreaterThan(0);
  expect(handed[0]?.data ?? {}).toMatchObject({ action: 'send', caller: senderId, target: targetId });
  // The tool answered the caller with the target's own receipt, not a guess: the
  // sender's transcript carries the call and the target it reached.
  await expect.poll(async () => (await view(daemon, senderId)).messages.map(message => message.text ?? '').join('\n'),
    { timeout: 30_000, interval: 250 }).toContain('conversation_write');
  const transcript = (await view(daemon, senderId)).messages.map(message => message.text ?? '').join('\n');
  // The call did not fail on the way: a refused handoff is the failure this test
  // exists to rule out.
  expect(transcript).not.toContain('Tool failed');
}, 180_000);
