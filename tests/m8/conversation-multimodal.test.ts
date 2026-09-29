import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

test('a multimodal Main Agent receives image content from the workspace read tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-multimodal-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'photo.png'), Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=',
    'base64',
  ));

  const provider = await openaiServer([
    { tools: [{ id: 'read-image', name: 'read', arguments: JSON.stringify({ path: 'photo.png' }) }] },
    { text: 'The image is a tiny transparent square.' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'agent-combinations.json') },
    models: {
      entries: [{
        id: 'local-vision',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
        input: ['text', 'image'],
      } as never],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    projects: [{ id: 'p', root: project }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'local-vision' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const created = await runtime.conversations.create({
    projectId: 'p',
    text: '读取 photo.png 并描述图片。',
    requestId: 'main-multimodal-image',
  });
  await runtime.host.runReady();

  expect(JSON.stringify(provider.requests[1])).toContain('image_url');
  expect(JSON.stringify(provider.requests[1])).not.toContain('Current model does not support images');
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions).toEqual([]);
  const readMessage = view.messages.find(message => message.role === 'tool' && message.data && typeof message.data === 'object'
    && !Array.isArray(message.data) && Array.isArray(message.data.attachments));
  expect(readMessage).toBeDefined();
  expect(readMessage!.data).toMatchObject({ attachments: [{ type: 'image/png' }] });
  expect(JSON.stringify(view)).not.toContain('iVBORw0KGgo');
  expect(runtime.conversations.attachment(readMessage!.id, 0).bytes.subarray(0, 8))
    .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text)
    .toContain('tiny transparent square');
}, 120_000);
