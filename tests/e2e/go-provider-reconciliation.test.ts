import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What the ledger knows when the provider does not answer.
 *
 * A socket lost after the request was sent cannot tell the client whether the
 * provider billed it. The ledger must keep that gap: the evidence of the
 * attempt stays correlatable - the same id on the wire, in the invocation
 * ledger and in the transport observations - and the usage stays unknown
 * instead of becoming zero. A connection that dies before any reply byte is
 * sent again on a fresh connection, to a bound: no reply arrived, so no tool
 * can have run, while every failed attempt keeps its unknown usage.
 *
 * Only the external provider is replaced. The proof is the real daemon and a
 * real endpoint that records every request it was sent.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

const variants = ['complete', 'lost-before-headers', 'proxy-503', 'proxy-429'] as const;
type Variant = typeof variants[number];

interface Received { id: string | undefined; hash: string }

interface Observation {
  callId: string;
  phase: string;
  requestSha256: string | null;
  clientRequestId: string | null;
  status?: number;
  responseIds?: Record<string, string>;
  errorCodes?: string[];
  errorNames?: string[];
  usageRecoverableFromTransport?: boolean;
  operationId: string;
  model: string;
}

interface Invocation {
  id: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
  usageSource: string;
  cost: unknown;
}

interface NodeRunView {
  operations?: { id: string; workerActive: boolean }[];
  invocations?: Invocation[];
}

async function vendor(variant: Variant): Promise<{
  baseUrl: string;
  received: Received[];
  close: () => Promise<void>;
}> {
  const received: Received[] = [];
  const server: Server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({
      id: typeof request.headers['x-opencode-request-id'] === 'string' ? request.headers['x-opencode-request-id'] : undefined,
      hash: createHash('sha256').update(body).digest('hex'),
    });
    if (variant === 'lost-before-headers') { request.socket.destroy(); return; }
    if (variant === 'proxy-503' || variant === 'proxy-429') {
      response.writeHead(variant === 'proxy-503' ? 503 : 429, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"upstream unavailable"}}');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream',
      'x-request-id': 'fixture-provider-request',
      'set-cookie': 'do-not-persist-cookie',
    });
    response.end(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', model: 'local',
      choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    received,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test.each(variants)('provider reconciliation retains correlatable evidence without inventing usage: %s', async variant => {
  const provider = await vendor(variant);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-reconciliation-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    models: { entries: [{
      id: 'local', modelId: 'local', provider: 'opencode-go', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    }] },
    credentials: { local: { secretRef: 'GRAPH_RECONCILIATION_KEY' } },
    limits: {},
  }, null, 2));

  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_RECONCILIATION_KEY: 'do-not-persist-secret' },
    extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Reply Done.', requestId: 'reconciliation-proof' }),
  });
  expect(created.status).toBe(200);
  const { taskId, conversationId } = await created.json() as { taskId: string; conversationId: string };

  // The turn has to settle before the ledger is read: a worker that is still
  // running may still add an attempt.
  await expect.poll(async () => {
    const view = await daemon.request(`/api/tasks/${taskId}/nodes/master/run`);
    const body = await view.json() as NodeRunView;
    const operations = body.operations ?? [];
    const invocations = body.invocations ?? [];
    return operations.length > 0 && operations.every(operation => !operation.workerActive) && invocations.length > 0;
  }, { timeout: 60_000, interval: 250 }).toBe(true);

  // A failed turn can schedule host recovery after the operation settles.
  for (const action of ['pause', 'interrupt']) {
    const stopped = await daemon.request(`/api/conversations/${conversationId}/${action}`, {
      method: 'POST', body: JSON.stringify({ requestId: `reconciliation-${action}` }),
    });
    const result = await stopped.json() as { code?: string };
    expect(stopped.status === 200 || (action === 'interrupt' && result.code === 'no_active_operation'), `${action}: ${JSON.stringify(result)}`).toBe(true);
  }

  const runView = await (await daemon.request(`/api/tasks/${taskId}/nodes/master/run`)).json() as NodeRunView;
  const invocations = runView.invocations ?? [];
  const events = await (await daemon.request(`/api/tasks/${taskId}/events?after=0&limit=500`)).json() as { type: string; data: Observation }[];
  const observations = events.filter(event => event.type === 'provider.transport').map(event => event.data);

  // The provider was asked, and every attempt carries its own correlation id.
  expect(provider.received.length).toBeGreaterThan(0);
  expect(new Set(provider.received.map(request => request.id)).size).toBe(provider.received.length);

  for (const request of provider.received) {
    expect(request.id, 'the gateway forwards a correlation id').toMatch(/^[0-9a-f-]{36}$/);
    // The id is the invocation: the wire and the ledger agree on one attempt.
    const invocation = invocations.find(candidate => candidate.id === request.id);
    expect(invocation, 'the correlation id is the invocation it belongs to').toBeTruthy();
    const call = observations.filter(observation => observation.callId === request.id);
    expect(call.length).toBeGreaterThan(0);
    // What left the process is what the provider received.
    expect(call).toContainEqual(expect.objectContaining({ phase: 'fetch_started', requestSha256: request.hash }));
    expect(call).toContainEqual(expect.objectContaining({ clientRequestId: request.id }));
    if (variant === 'complete') {
      expect(call).toContainEqual(expect.objectContaining({ phase: 'response_headers', status: 200, responseIds: { 'x-request-id': 'fixture-provider-request' } }));
    } else if (variant === 'lost-before-headers') {
      const failure = call.find(observation => observation.phase === 'transport_error');
      expect(failure, 'the lost socket is named').toBeTruthy();
      // The connection ended before the provider answered: the failure is
      // named by identifiers, never by a message that could carry a URL.
      expect(failure!.errorCodes, JSON.stringify(failure)).toContain('EOF');
      expect(failure!.errorNames, JSON.stringify(failure)).toContain('EOF');
      expect(failure!.errorNames?.length ?? 0, JSON.stringify(failure)).toBeGreaterThan(0);
      expect(failure!.usageRecoverableFromTransport).toBe(false);
    } else {
      expect(call).toContainEqual(expect.objectContaining({ phase: 'response_headers', status: variant === 'proxy-503' ? 503 : 429 }));
    }
  }

  // The observations are correlation evidence: they never carry the secret,
  // the authorization header or a cookie.
  expect(JSON.stringify(observations)).not.toMatch(/do-not-persist|authorization|set-cookie/i);

  if (variant === 'complete') {
    // The provider answered, so the usage is the provider's own numbers and
    // the call is priced.
    expect(provider.received).toHaveLength(1);
    const invocation = invocations.find(candidate => candidate.id === provider.received[0]!.id)!;
    expect(invocation.usage).toMatchObject({ input: 20, output: 7, cacheRead: 10, cacheWrite: 0 });
    expect(invocation.usageSource).toBe('authoritative');
    expect((invocation.cost as { amount?: number }).amount).toBeGreaterThan(0);
  } else if (variant === 'lost-before-headers') {
    // Nothing came back before the socket died, so the turn is retried to the
    // bound; every attempt that died keeps its unknown usage and is never
    // priced, and none of them invents an answer.
    expect(provider.received).toHaveLength(3);
    for (const request of provider.received) {
      const invocation = invocations.find(candidate => candidate.id === request.id)!;
      expect(invocation.usage).toBeNull();
      expect(invocation.usageSource).toBe('unknown');
      expect(claimsNoCost(invocation.cost), JSON.stringify(invocation.cost)).toBe(true);
    }
  } else {
    // A capacity answer is retried, and every attempt is kept: each one is
    // unknown in usage and unpriced, so the ledger never claims a number the
    // provider did not report.
    expect(provider.received.length).toBeGreaterThan(1);
    for (const request of provider.received) {
      const invocation = invocations.find(candidate => candidate.id === request.id)!;
      expect(invocation.usage).toBeNull();
      expect(invocation.usageSource).toBe('unknown');
      expect(claimsNoCost(invocation.cost), JSON.stringify(invocation.cost)).toBe(true);
    }
  }
}, 120_000);

/** A cost that is unknown or absent claims nothing. */
function claimsNoCost(cost: unknown): boolean {
  if (cost == null) return true;
  const record = cost as { unknown?: boolean; amount?: number };
  return record.unknown === true || record.amount == null;
}
