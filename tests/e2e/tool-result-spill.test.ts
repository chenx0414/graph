import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A tool result too large to carry is written to a file, and the model is told
 * where the file is.
 *
 * The file holds every byte, so the model can read the rest of the result by
 * offset and limit. A result that was merely cut would be lost, and the output
 * of a long command is exactly what a coding agent needs to keep.
 *
 * The output here is larger than the kernel's own truncation limit: without the
 * seam the result would have been cut there, and the cut would have been final.
 */

test('a large command result is written to a file and the model is given the handle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-tool-spill-'));
  const project = join(root, 'project');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');
  // The provider answers with the tool call and then with the answer; the
  // command itself is the one the real sandbox runs.
  const provider = await openaiServer([
    { tools: [{ id: 'many-lines', name: 'bash', arguments: JSON.stringify({ command: "awk 'BEGIN{for(i=0;i<8000;i++) print \"line-\" i}'" }) }] },
    { text: 'The lines are ready.' },
  ]);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_SPILL_TEST_KEY' } },
    models: { entries: [{ id: 'main', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    env: { GRAPH_SPILL_TEST_KEY: 'synthetic-only' },
    extraArgs: ['--execute'],
    configPath,
  });
  try {
    const created = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Print eight thousand lines.', requestId: 'spill-first' }),
    });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json();
      return view.master?.status;
    }, { timeout: 30_000 }).toBe('succeeded');

    // The result the model read is a bounded summary with a handle.
    const second = provider.requests[1] as { messages?: { role: string; content: unknown }[] };
    const toolMessage = (second.messages ?? []).find(message => message.role === 'tool');
    expect(toolMessage).toBeDefined();
    const text = String(toolMessage!.content);
    expect(text).toContain('[large tool result:');
    expect(text).toContain('handle:');
    expect(text.length).toBeLessThan(25_000);

    // The handle holds every byte of the output: the kernel's own limit would
    // have cut it at fifty kilobytes.
    const handle = /handle: (\S+)/.exec(text)?.[1];
    expect(handle).toBeDefined();
    const spilled = await readFile(handle!, 'utf8');
    expect(spilled).toContain('line-0');
    expect(spilled).toContain('line-7999');
    expect(spilled.length).toBeGreaterThan(70_000);

    // The summary must not promise more than the handle holds: a handle to a
    // short file is a result the model can never read back.
    const claimedChars = /(\d+) chars/.exec(text)?.[1];
    if (claimedChars) {
      expect(spilled.length, 'the handle holds the characters the summary claims').toBe(Number(claimedChars));
    }
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
