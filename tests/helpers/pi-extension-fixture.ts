import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { launchCli } from './cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The shared sandbox for the Pi extension tests: one daemon, one capability and
 * one extension module on disk.
 *
 * It lives here rather than in a test file because the contract is asserted from
 * two angles - the tool surface and the session lifecycle - and a test file may
 * not grow past the repository's own file budget.
 */
export interface ConversationMessage { role?: string; kind?: string; text?: string }
export interface ConversationView {
  master?: { status?: string };
  messages?: ConversationMessage[];
  questions?: { kind?: string; owner?: string; status?: string; data?: { output?: { setupError?: string } } }[];
}

/** One daemon, one capability, one pi extension on disk. */
export async function withExtension(
  source: string,
  declaredTools: { name: string; description: string }[],
  run: (context: {
    daemon: Awaited<ReturnType<typeof launchCli>>;
    provider: Awaited<ReturnType<typeof openaiServer>>;
    project: string;
    capabilityDirectory: string;
  }) => Promise<void>,
  access?: unknown,
  script?: Parameters<typeof openaiServer>[0],
) {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-pi-extension-'));
  const project = join(root, 'project');
  const home = join(root, 'graph-home');
  await mkdir(project);
  await mkdir(home);

  const capabilityDirectory = join(home, 'capabilities', 'pi-extension', 'proof-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), source);
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'proof', kind: 'pi-extension', version: '1.0.0', name: 'Proof extension',
    entry: './index.mjs',
    tools: declaredTools,
  }));
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with a Pi extension.',
      recommendedGrade: 'high', review: false, tags: [],
      resources: [{ resourceId: 'proof', version: '1.0.0', role: 'pi-extension', required: false }],
    }],
  }));

  // The model calls the tool the extension registered: the extension is the
  // authority on what it offers, and the call is the only way to reach it.
  const called = declaredTools[0]?.name ?? 'proof_tool';
  const provider = await openaiServer(script ?? [
    { tools: [{ id: 'call-proof', name: called, arguments: JSON.stringify({}) }] },
    { text: 'The extension answered.' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_PI_EXTENSION_KEY' } },
      ...(access === undefined ? {} : { access }),
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: {
      GRAPH_PIG_PI_EXTENSION_KEY: 'synthetic-only',
      GRAPH_PIG_PI_EXTENSION_MARKER: join(capabilityDirectory, 'tool-ran.txt'),
    }, extraArgs: ['--execute', '--kernel', 'pig'] });
    await run({ daemon, provider, project, capabilityDirectory });
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

