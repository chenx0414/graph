import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openDurablePlugins } from '../../src/runtime/durable-plugin.ts';
import type { AgentSessionRequest } from '../../src/runtime/agent-session.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('a frozen plugin package runs its real tool and hooks while its OS policy denies writes outside granted roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'durable-plugins-'));
  const provider = await openaiServer([]);
  const workspace = join(root, 'workspace');
  const capability = join(root, 'capability');
  const stateDir = join(root, 'state');
  await mkdir(workspace); await mkdir(capability); await mkdir(stateDir);
  await writeFile(join(capability, 'capability.json'), '{}');
  await writeFile(join(capability, 'value.mjs'), "export const value = 'package-value';\n");
  await writeFile(join(capability, 'index.mjs'), `
    import { writeFile } from 'node:fs/promises';
    import { value } from './value.mjs';
    export default pi => {
      pi.on('before_agent_start', async (event, ctx) => ({ systemPrompt: ctx.getSystemPrompt() + ':plugin-policy', message: { customType: 'plugin-context', content: 'frozen-plugin-context', display: false } }));
      pi.registerTool({ name: 'plugin_write', label: 'Plugin write', description: 'Write from a plugin', parameters: {type:'object', properties:{path:{type:'string'}}, required:['path']},
        async execute(id, args) { await writeFile(args.path, value); return {content:[{type:'text', text:value}],details:{}}; }
      });
    };
  `);
  let plugins: Awaited<ReturnType<typeof openDurablePlugins>> | undefined;
  try {
    const request: AgentSessionRequest = { binding: { instanceId: 'plugin-owner', nodeId: 'worker', definitionVersion: 'worker@1' }, workspace, stateDir,
      model: provider.model, stream: () => { throw new Error('A capability helper must never invoke a model'); },
      piExtensionPaths: [join(capability, 'index.mjs')], piExtensionTools: ['plugin_write'], systemPrompt: 'worker-policy',
      bundleDigest: 'plugin-version-1', toolPolicyDigest: 'bounded-tools', runtimePolicyDigest: 'bounded-runtime',
      broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    };
    plugins = await openDurablePlugins(request);
    const initialized = await plugins.beforePrompt('Build according to the plan');
    expect(initialized.systemPrompt).toBe('worker-policy:plugin-policy');
    expect(initialized.messages).toEqual([{ customType: 'plugin-context', content: 'frozen-plugin-context', display: false }]);
    const tool = plugins.tools.find(tool => tool.name === 'plugin_write')!;
    await tool.execute('write-approved', {path:join(workspace, 'result.txt')}, undefined, undefined, undefined!);
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('package-value');
    await expect(tool.execute('write-denied', {path:join(root, 'outside.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    await expect(readFile(join(root, 'outside.txt'))).rejects.toMatchObject({code:'ENOENT'});
    await plugins.close();
    plugins = await openDurablePlugins({ ...request, readOnly: true, filesystemAccess: 'host' });
    const reviewerTool = plugins.tools.find(tool => tool.name === 'plugin_write')!;
    await expect(reviewerTool.execute('review-denied', {path:join(workspace, 'result.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    await expect(reviewerTool.execute('review-outside-denied', {path:join(root, 'outside.txt')}, undefined, undefined, undefined!)).rejects.toThrow();
    expect(await readFile(join(workspace, 'result.txt'), 'utf8')).toBe('package-value');
    expect(provider.requests).toEqual([]);
  } finally { await plugins?.close(); await provider.close(); await rm(root, {recursive:true,force:true}); }
}, 30_000);
