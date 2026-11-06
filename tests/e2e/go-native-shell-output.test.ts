// 这个文件在 tests/env-layers.json 里登记为 nested-sandbox 层：它要让 daemon 跑真命令取回
// 真实输出，而 daemon 的 bash 工具会把命令裹进 macOS seatbelt，seatbelt 不能嵌套。
// 已经身处 seatbelt 的进程只能得到 `sandbox_apply: Operation not permitted`，命令退出 71、
// 没有输出，这些用例于是只等到超时。那是缺少能力，不是回归：宿主门禁会跑它。
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A shell that printed a great deal stays readable.
 *
 * The bytes a command printed are the answer to what happened; a model that
 * only sees a cut-off view has to guess. So a large result is kept whole on
 * disk, the model gets a compact view of it and the path of the whole thing,
 * and the path keeps working after the daemon is replaced.
 *
 * The proof is a real daemon, a real shell and the real file: the command
 * really ran, the file really holds every line, the model really read the
 * middle of it through the read tool, and the file is still there after a
 * restart.
 */

const LINES = 5000;
const output = Array.from({ length: LINES }, (_, index) => index === 2499 ? 'MIDDLE-OUTPUT-PROOF' : index === 4999 ? 'FINAL-OUTPUT-PROOF' : `diagnostic-line-${index}`).join('\n') + '\n';

test('a large shell result stays whole on disk and readable after a restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-native-output-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'A project.\n');

  const command = `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(output)});process.exitCode=7;`)}`;
  const provider = await openaiServer([
    { tools: [{ id: 'large-output', name: 'bash', arguments: JSON.stringify({ command }) }] },
    { tools: [{ id: 'read-middle', name: 'read', arguments: () => JSON.stringify({ path: fullOutputPath(), offset: 2500, limit: 1 }) }] },
    { text: 'Middle output verified.' },
  ]);
  const toolText = (index: number) => (provider.requests[index] as { messages: { role: string; content: unknown }[] })
    .messages.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n');
  let spilled = '';
  const fullOutputPath = () => {
    const match = /Full output: ([^\s\]"\\]+)/.exec(toolText(1));
    if (!match) throw new Error(`The model was not told where the whole output is: ${toolText(1).slice(0, 400)}`);
    spilled = match[1]!;
    return spilled;
  };

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_OUTPUT_TEST_KEY' } },
    models: { entries: [
      { id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 1_000_000, maxTokens: 256, credentialId: 'local' },
    ] },
  }));
  const options = {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph-home'), webDir: join(root, 'web'),
    env: { GRAPH_OUTPUT_TEST_KEY: 'fixture', GRAPH_COMPACT_SHELL_RESULTS: '1' }, extraArgs: ['--execute'],
  };

  let daemon = await launchCli(root, options);
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run the diagnostic and verify its middle output.', requestId: 'begin' }),
    });
    expect(started.status).toBe(200);
    const conversationId = (await started.json() as { conversationId: string }).conversationId;

    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string }[] };
      return view.messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBe(1);

    // The model saw a compact view of the output, not the whole thing.
    const first = toolText(1);
    expect(first).toContain('FINAL-OUTPUT-PROOF');
    expect(first).toContain('code 7');
    expect(first.length).toBeLessThan(2000);

    // The whole output is on disk, and the file is the real thing.
    const path = fullOutputPath();
    expect(await readFile(path, 'utf8')).toBe(output);

    // The model really read the middle of it.
    expect(toolText(2)).toContain('MIDDLE-OUTPUT-PROOF');

    // The daemon is replaced; the file and its bytes are still there.
    await daemon.close();
    daemon = await launchCli(root, options);
    const resumed = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Read the saved output after restart.', requestId: 'again' }),
    });
    expect(resumed.status).toBe(200);
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string }[] };
      return view.messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBe(2);
    expect(await readFile(path, 'utf8')).toBe(output);
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test('without the compact view the model still gets the whole output on disk', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-native-output-plain-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'A project.\n');

  const command = `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(output)});process.exitCode=7;`)}`;
  const provider = await openaiServer([
    { tools: [{ id: 'large-output', name: 'bash', arguments: JSON.stringify({ command }) }] },
    { tools: [{ id: 'read-middle', name: 'read', arguments: () => JSON.stringify({ path: fullOutputPath(), offset: 2500, limit: 1 }) }] },
    { text: 'Middle output verified.' },
  ]);
  const toolText = (index: number) => (provider.requests[index] as { messages: { role: string; content: unknown }[] })
    .messages.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n');
  const fullOutputPath = () => {
    const match = /Full output: ([^\s\]"\\]+)/.exec(toolText(1));
    if (!match) throw new Error(`The model was not told where the whole output is: ${toolText(1).slice(0, 400)}`);
    return match[1]!;
  };

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_OUTPUT_TEST_KEY' } },
    models: { entries: [
      { id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 1_000_000, maxTokens: 256, credentialId: 'local' },
    ] },
  }));

  const daemon = await launchCli(root, {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph-home'), webDir: join(root, 'web'),
    env: { GRAPH_OUTPUT_TEST_KEY: 'fixture', GRAPH_COMPACT_SHELL_RESULTS: '0' }, extraArgs: ['--execute'],
  });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run the diagnostic.', requestId: 'begin' }),
    });
    expect(started.status).toBe(200);
    const conversationId = (await started.json() as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string }[] };
      return view.messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 60_000, interval: 250 }).toBe(1);

    // The uncompacted view is the shell's own ceiling, not the compact one.
    const first = toolText(1);
    expect(first.length).toBeGreaterThan(10_000);
    expect(await readFile(fullOutputPath(), 'utf8')).toBe(output);
    expect(toolText(2)).toContain('MIDDLE-OUTPUT-PROOF');
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test('a compacted shell result is not pruned away by the commands that follow it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-native-output-retained-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'A project.\n');

  const command = `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(output)});process.exitCode=7;`)}`;
  const provider = await openaiServer([
    { tools: [{ id: 'large-output', name: 'bash', arguments: JSON.stringify({ command }) }] },
    { tools: [{ id: 'read-middle', name: 'read', arguments: () => JSON.stringify({ path: fullOutputPath(), offset: 2500, limit: 1 }) }] },
    { tools: Array.from({ length: 256 }, (_, index) => ({
      id: `retention-${index}`, name: 'bash', arguments: JSON.stringify({ command: `printf 'retention-${index}-%05000d' 0` }),
    })) },
    { tools: [{ id: 'read-old-handle', name: 'read', arguments: () => JSON.stringify({ path: fullOutputPath(), offset: 4900, limit: 200 }) }] },
    { text: 'The old result is still there.' },
  ]);
  const toolText = (index: number) => (provider.requests[index] as { messages: { role: string; content: unknown }[] })
    .messages.filter(message => message.role === 'tool').map(message => String(message.content)).join('\n');
  const fullOutputPath = () => {
    const match = /Full output: ([^\s\]"\\]+)/.exec(toolText(1));
    if (!match) throw new Error(`The model was not told where the whole output is: ${toolText(1).slice(0, 400)}`);
    return match[1]!;
  };

  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_OUTPUT_TEST_KEY' } },
    models: { entries: [
      { id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 1_000_000, maxTokens: 256, credentialId: 'local' },
    ] },
  }));

  const daemon = await launchCli(root, {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph-home'), webDir: join(root, 'web'),
    env: { GRAPH_OUTPUT_TEST_KEY: 'fixture', GRAPH_COMPACT_SHELL_RESULTS: '1' }, extraArgs: ['--execute'],
  });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run the diagnostic, then a lot of small ones.', requestId: 'begin' }),
    });
    expect(started.status).toBe(200);
    const conversationId = (await started.json() as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/conversations/${conversationId}`)).json() as { messages: { role: string }[] };
      return view.messages.filter(message => message.role === 'assistant').length;
    }, { timeout: 420_000, interval: 500 }).toBe(1);

    // 257 shell results later, the first one is still on disk and still readable.
    expect(toolText(4)).toContain('FINAL-OUTPUT-PROOF');
    expect(await readFile(fullOutputPath(), 'utf8')).toBe(output);
  } finally {
    await daemon.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 600_000);
