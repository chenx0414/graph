import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

async function temp(name: string) {
  return mkdtemp(join(tmpdir(), `graph-skill-${name}-`));
}

async function waitFor(check: () => Promise<boolean> | boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting');
}

const MARKER = 'SKILL-BODY-MARKER-9137';

/** A message carries either a string or content blocks; read whichever this transport used. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(part => typeof part === 'string' ? part : (part as { text?: string } | null)?.text ?? '').join('');
  }
  return '';
}

/**
 * Selecting a skill with `/skill:<name>` must put that skill's body in front of the model.
 *
 * The assertion reads the request the provider really received. A client-side hint would pass a
 * weaker test and still leave the model without the skill, which is the defect this closes: a
 * `disable-model-invocation` skill is not in the system prompt at all.
 */
test('a /skill:<name> message reaches the model with that skill body and nothing invented', async () => {
  const root = await temp('invoke');
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skill = join(capabilityRoot, 'demo-skill');
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, 'capability.json'), JSON.stringify({
    id: 'demo-skill', kind: 'skill', version: '1.0.0', name: 'demo-skill',
    description: '仅用于测试的示例技能。',
  }));
  await writeFile(join(skill, 'SKILL.md'), `---\nname: demo-skill\ndescription: 仅用于测试\n---\n\n# Demo skill\n\n${MARKER}\n`);

  const provider = await openaiServer([{ text: '收到' }, { text: '收到' }, { text: 'extra' }]);
  cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    limits: { defaultBudgetTokens: 20_000_000 },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      apiKey: 'scripted-local-key', modelRuntime: provider.runtime,
      credentialFor: () => ({ credentialId: 'cred', apiKey: 'scripted-local-key' }),
    },
    master: { action: 'master', definitionVersion: 'main@1', model: 'local' },
  });
  cleanup.push(async () => { await Promise.race([server.close().catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]); });
  server.runtime.catalog.publishDefinition('main', { recommendedGrade: 'high', capabilities: [{ id: 'demo-skill', version: '1.0.0' }] }, 'main');

  const created = await server.runtime.conversations.create({ text: `/skill:demo-skill 请按它说的做`, requestId: 'create' });
  await server.runtime.host.runReady();
  await waitFor(() => provider.requests.length >= 1, 30_000);

  const body = provider.requests[0] as { messages?: { role?: string; content?: unknown }[] };
  const prompt = (body.messages ?? []).map(message => textOf(message.content)).join('\n');
  expect(prompt).toContain(MARKER);
  expect(prompt).toContain('The user explicitly requested these skills for this turn');
  expect(prompt).toContain('<skill name="demo-skill" version="1.0.0">');
  // The front matter is metadata, not instruction.
  expect(prompt).not.toContain('description: 仅用于测试');

  // The transcript keeps what the user typed: the body travels with the turn, it is not stored as theirs.
  const view = await server.runtime.conversations.view(created.conversationId, { limit: 10 });
  const message = view.messages.find(item => item.text.includes('/skill:demo-skill'));
  expect(message?.text).toBe('/skill:demo-skill 请按它说的做');
  expect(view.messages.some(item => item.text.includes(MARKER))).toBe(false);

  // An unbound name is reported to the model instead of being silently skipped.
  await server.runtime.conversations.chat(created.conversationId, { text: '/skill:not-bound 看一下', requestId: 'chat-2' });
  await server.runtime.host.runReady();
  await waitFor(() => provider.requests.some(request => JSON.stringify(request).includes('not-bound')), 30_000);
  const secondBody = provider.requests.find(request => JSON.stringify(request).includes('not-bound')) as { messages?: { content?: unknown }[] };
  const secondPrompt = (secondBody.messages ?? []).map(message => textOf(message.content)).join('\n');
  expect(secondPrompt).toContain('Not injected: `not-bound` (not bound to this Agent)');
  // The session still holds the first turn, so the marker remains in its history; what must not
  // happen is the turn that asked for the unbound skill carrying a body of its own.
  const notBoundTurn = (secondBody.messages ?? []).map(message => textOf(message.content)).find(text => text.includes('not-bound')) ?? '';
  expect(notBoundTurn).not.toContain(MARKER);
}, 120_000);
