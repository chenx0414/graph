import { join } from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import {
  DATA, type ProviderCall, chatgptCredential, grokAccessToken, implementerProvider, independentEntries,
  rows, scriptedProvider,
} from './provider-independent-reviews.fixture.ts';

/**
 * Two independent providers, each running for real.
 *
 * Grok and ChatGPT are configured as their own model entries, they answer a
 * completion each through the daemon's own provider path, and the graph's
 * review node runs on one of them while the implementer runs on another model.
 * The report therefore names two different model ids, and the provider call
 * records - the same rows the kernel charges - are the evidence that the review
 * really came from the independent provider.
 */
test('Grok and ChatGPT are independent model entries, each completes for real, and the review node runs on the independent provider', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-independent-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  const grok = await grokAccessToken();
  const chatgpt = await chatgptCredential();
  const entries = await independentEntries();

  const definition = {
    schemaVersion: 2,
    name: 'Independent review',
    protocols: { data: { type: 'object' } },
    nodes: {
      implement: {
        recipe: 'coder@1', model: 'implementer', task: 'Write the delivered file and submit what you delivered',
        inputs: { job: DATA }, outputs: { out: DATA }, submission: { required: ['out'] },
      },
      review: {
        recipe: 'reviewer@1', model: 'chatgpt:gpt-6.1-sol', task: 'Review the delivered work of node implement and submit your report',
        inputs: { work: DATA }, outputs: { report: DATA }, submission: { required: ['report'] },
      },
    },
    modules: {},
    edges: { handoff: { from: 'implement.out', to: 'review.work', enabled: true } },
    inputs: {},
    outputs: { report: { from: 'review.report', protocol: 'data' } },
  };

  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  const implementer = await implementerProvider();
  /**
   * The reviewer's own execution, read from the kernel's own rows: it is done
   * when the execution it ran under stopped running, whether or not the model
   * needed a second turn to submit its report.
   */
  const waitForReview = async () => {
    for (let attempt = 0; attempt < 900; attempt += 1) {
      const states = rows<{ state: string }>(root,
        "SELECT state FROM kernel_executions WHERE task_id=? AND node_id='review' ORDER BY rowid", graphIdOf());
      if (states.length > 0 && states.every(row => row.state !== 'running')) return;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('the review node never finished its execution');
  };

  const master = await scriptedProvider(() => {
    const graphId = graphIdOf();
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'implement', input: 'job', value: { marker: 'go' } } },
      {
        id: 'calls', name: 'graph_inspect', args: { graphId, query: 'provider_calls' },
        before: async () => { await waitForReview(); },
      },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' } },
      { id: 'nodes', name: 'graph_inspect', args: { graphId, query: 'nodes' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

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
      credentials: {
        local: { secretRef: 'GRAPH_INDEPENDENT_KEY' },
        // The host's connected subscriptions, by the reference the product uses.
        grok: { secretRef: 'GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN', displayName: 'grok 订阅', platform: 'grok' },
        chatgpt: { secretRef: 'GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN', displayName: 'chatgpt 订阅' },
      },
      models: { entries: [
        { id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'frontier', api: 'openai-completions',
          baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' },
        { id: 'implementer', provider: 'graph-node-sender', modelId: 'implementer-model', grade: 'medium', api: 'openai-completions',
          baseUrl: implementer.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' },
        // The delivered independent entries, unchanged: Grok on the xAI
        // endpoint (chat-completions) and ChatGPT on its Codex endpoint
        // (Responses).
        entries.grok, entries.chatgpt,
      ] },
    }));
    daemon = await launchCli(root, {
      configPath,
      env: {
        GRAPH_INDEPENDENT_KEY: 'independent-synthetic',
        GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN: grok,
        GRAPH_SUBSCRIPTION_CHATGPT_ACCESS_TOKEN: chatgpt.token,
        // The daemon verifies provider certificates against the system trust
        // bundle. A process spawned from this test is outside the platform
        // verifier's session, so the same roots are named explicitly instead of
        // letting every real HTTPS call fail with OSStatus -26276.
        SSL_CERT_FILE: '/etc/ssl/cert.pem',
        SSL_CERT_DIR: '/etc/ssl',
      },
      extraArgs: ['--execute'],
    });
    // Each entry really completes: a conversation turn the provider answers.
    const replies: Record<string, string> = {};
    const probes: [string, string][] = [['grok:grok-4.5', 'grok-ok'], ['chatgpt:gpt-6.1-sol', 'chatgpt-ok']];
    for (const [model, marker] of probes) {
      const created = await request('/api/conversations', {
        method: 'POST',
        body: JSON.stringify({ projectId: 'p', model, text: `Reply with exactly this and nothing else: ${marker}`, requestId: `probe-${marker}` }),
      });
      expect(created.status, JSON.stringify(created.body)).toBe(200);
      const conversationId = (created.body as { conversationId: string }).conversationId;
      expect(conversationId).toBeTruthy();
      const deadline = Date.now() + 180_000;
      let text = '';
      let view: unknown = {};
      while (Date.now() < deadline) {
        const conversation = await request(`/api/conversations/${conversationId}`);
        view = conversation.body;
        const status = (view as { master?: { status?: string } }).master?.status;
        const history = await request(`/api/conversations/${conversationId}/history`);
        const messages = (history.body as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
        text = messages.filter(message => message.role === 'assistant').map(message => message.text ?? '').join('\n');
        if (text.includes(marker)) break;
        // A turn that already ended without the answer is a failure now, not a
        // slower one later: the reason is the reason the daemon recorded.
        const failure = messages.find(message => message.kind === 'error');
        if (failure || status === 'failed' || status === 'blocked') {
          throw new Error(`the ${model} turn failed instead of answering: ${failure?.text ?? status} ${JSON.stringify(view).slice(0, 2000)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      replies[model] = text;
      expect(text, `the ${model} completion really answered: ${text}`).toContain(marker);
    }

    // The graph: a local implementer and a real ChatGPT reviewer.
    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the independent review.', requestId: 'independent-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('nodes') || master.failures.length > 0, { timeout: 420_000, interval: 500 }).toBe(true);
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    const calls = JSON.parse(master.results.get('calls')!) as ProviderCall[];
    const byNode = new Map(calls.map(call => [call.nodeId, call]));
    // Two different model ids: the implementer's and the reviewer's.
    const implementerCall = byNode.get('implement')!;
    const reviewerCall = byNode.get('review')!;
    expect(implementerCall.model.id).toBe('implementer');
    expect(reviewerCall.model.id).toBe('chatgpt:gpt-6.1-sol');
    expect(reviewerCall.model.id).not.toBe(implementerCall.model.id);
    // The reviewer's call is the review recipe, and it settled against the
    // provider: the independence is the kernel's own record, not a claim.
    expect(reviewerCall.model.recipe).toMatchObject({ definition: 'reviewer@1', review: true });
    expect(implementerCall.model.recipe).toMatchObject({ review: false });
    expect(reviewerCall.state).toBe('settled');
    expect(reviewerCall.model.api).toBe('openai-responses');

    // The reviewer really ran (it read the work and answered) and its report
    // reached the graph's own output.
    const reviewCalls = calls.filter(call => call.nodeId === 'review');
    expect(reviewCalls.every(call => call.model.id === 'chatgpt:gpt-6.1-sol')).toBe(true);
    expect(reviewCalls.some(call => call.state === 'settled')).toBe(true);
    const results = JSON.parse(master.results.get('results')!) as { output_name: string; value: unknown }[];
    expect(results.map(row => row.output_name)).toContain('report');
    // The implementer's own turn really happened: it wrote and submitted.
    expect(implementer.turns.length).toBeGreaterThanOrEqual(2);
  } finally {
    await daemon?.close(); await master.close(); await implementer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 700_000);
