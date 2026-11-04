import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A correct ChatGPT draft is accepted, and probed with the transport it names.
 *
 * The runtime speaks the OpenAI Responses contract to ChatGPT's Codex backend,
 * the Go platform preset says so, and the console catalog now says so too - but
 * the settings page validates a draft against an allow list that only knew
 * chat-completions and anthropic-messages. That list had already learned to
 * *mention* openai-responses in its refusal text while still refusing it, so a
 * correct official draft was rejected with a message naming the transport it
 * was rejecting.
 *
 * The proof is a real daemon: the provider directory it serves is read, that
 * directory's own ChatGPT draft is sent back to the probe endpoint, and the
 * endpoint the probe talks to records the request it received. Before the
 * allow-list fix the probe answers 400 and never sends anything.
 */

interface ProviderPreset {
  id: string;
  label: string;
  api: string;
  baseUrl: string;
  credentialRef: string;
  notes?: string[];
}

/** Validating a draft whose transport the fix added: a refusal names the field. */

interface ProbeAnswer {
  provider: { id: string; api: string };
  credentialConfigured: boolean;
  verification: { ok: boolean; status?: number; error?: string };
}

/** A stand-in for the Codex backend: it answers the Responses verify request. */
async function responsesEndpoint() {
  const hits: { method: string; url: string; body: Record<string, unknown> }[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    hits.push({ method: request.method ?? 'GET', url: request.url ?? '/', body: raw ? JSON.parse(raw) as Record<string, unknown> : {} });
    response.writeHead(200, { 'content-type': 'application/json' });
    // The probe only needs a 2xx to call the credential verified.
    response.end(JSON.stringify({ id: 'resp_probe', object: 'response', status: 'completed', model: 'gpt-6.1-sol', output: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    baseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('the provider directory and the draft probe both speak openai-responses for ChatGPT, so a correct draft is accepted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-provider-draft-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const endpoint = await responsesEndpoint();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };

  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_DRAFT_KEY' }, chatgpt: { secretRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'frontier', api: 'openai-completions',
        baseUrl: 'http://127.0.0.1:9/v1', contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, {
      configPath,
      env: { GRAPH_DRAFT_KEY: 'draft-synthetic', GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN: 'draft-chatgpt-token' },
      extraArgs: ['--execute'],
    });

    // The directory the settings page reads: ChatGPT is a Responses platform.
    const providers = await request('/api/providers');
    expect(providers.status, JSON.stringify(providers.body)).toBe(200);
    const presets = (providers.body as { platforms?: ProviderPreset[] }).platforms ?? [];
    const chatgpt = presets.find(preset => preset.id === 'chatgpt');
    expect(chatgpt, `the directory lists chatgpt: ${JSON.stringify(presets.map(preset => preset.id))}`).toBeTruthy();
    expect(chatgpt!.api).toBe('openai-responses');
    // The directory must not still describe ChatGPT as an unfinished adapter:
    // the settings page shows these notes next to the platform.
    const notes = (chatgpt!.notes ?? []).join(' ');
    expect(notes).toContain('Responses');
    expect(notes).not.toContain('尚未完成');

    // The draft that draft comes from: the same fields the wizard sends, with
    // the baseUrl pointed at the stand-in endpoint so the probe stays local.
    const draft = {
      requestId: 'chatgpt-draft-1',
      provider: {
        id: 'chatgpt', label: chatgpt!.label, api: chatgpt!.api, baseUrl: endpoint.baseUrl,
        credentialRef: chatgpt!.credentialRef, credentialKind: 'subscription',
      },
      modelId: 'gpt-6.1-sol',
      probeModels: false,
    };
    const probe = await request('/api/providers/probe', { method: 'POST', body: JSON.stringify(draft) });
    // Before the allow list knew the transport this was 400 with an api error,
    // and no request ever left the daemon.
    expect(probe.status, JSON.stringify(probe.body)).toBe(200);
    const answer = probe.body as ProbeAnswer;
    expect(answer.provider.api).toBe('openai-responses');
    expect(answer.credentialConfigured).toBe(true);
    expect(answer.verification, JSON.stringify(answer.verification)).toMatchObject({ ok: true, status: 200 });

    // And the probe really spoke that transport: the stand-in endpoint received
    // one Responses request carrying the model and an input item.
    expect(endpoint.hits.map(hit => `${hit.method} ${hit.url}`)).toContain('POST /backend-api/codex/responses');
    const sent = endpoint.hits[endpoint.hits.length - 1]!.body;
    expect(sent.model).toBe('gpt-6.1-sol');
    expect(sent).toHaveProperty('input');
    expect(sent).not.toHaveProperty('messages');

    // A draft naming a transport Graph does not speak is still refused, by name.
    const refused = await request('/api/providers/probe', {
      method: 'POST',
      body: JSON.stringify({
        requestId: 'chatgpt-draft-2',
        provider: { ...draft.provider, api: 'openai-telepathy' }, modelId: 'gpt-6.1-sol', probeModels: false,
      }),
    });
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain('api');
  } finally {
    await daemon?.close(); await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
