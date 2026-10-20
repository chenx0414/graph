import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';

const execute = promisify(execFile);

// Only the external provider is replaced. A socket lost after receipt cannot
// tell the client whether the provider billed it; the ledger must retain that gap.
test.each(['complete', 'lost-before-headers', 'proxy-503', 'proxy-429'] as const)('provider reconciliation retains correlatable evidence without inventing usage: %s', async variant => {
  const root = await mkdtemp(join(tmpdir(), 'graph-reconciliation-'));
  const received: { id: string | undefined; hash: string }[] = [];
  const vendor = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    received.push({ id: typeof request.headers['x-opencode-request-id'] === 'string' ? request.headers['x-opencode-request-id'] : undefined,
      hash: createHash('sha256').update(body).digest('hex') });
    if (variant === 'lost-before-headers') { request.socket.destroy(); return; }
    if (variant === 'proxy-503' || variant === 'proxy-429') {
      response.writeHead(variant === 'proxy-503' ? 503 : 429, { 'content-type': 'application/json' });
      response.end('{"error":{"message":"upstream unavailable"}}'); return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'fixture-provider-request', 'set-cookie': 'do-not-persist-cookie' });
    response.end(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', model: 'local', choices: [{ index: 0, delta: { content: 'Done.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 7, total_tokens: 37, prompt_tokens_details: { cached_tokens: 10 } } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise<void>(resolve => vendor.listen(0, '127.0.0.1', resolve));
  let daemon: Awaited<ReturnType<typeof startGraphDaemon>> | undefined;
  try {
    const webDir = join(root, 'web'); await mkdir(webDir); await writeFile(join(webDir, 'index.html'), '<!doctype html>Graph');
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_RECONCILIATION_KEY' } }, models: { entries: [{
      id: 'local', modelId: 'local', provider: 'opencode-go', grade: 'high', api: 'openai-completions',
      baseUrl: `http://127.0.0.1:${(vendor.address() as AddressInfo).port}/v1`, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] } }));
    daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true,
      env: { HOME: root, GRAPH_RECONCILIATION_KEY: 'do-not-persist-secret' }, log: () => undefined });
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
    const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers,
      body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Reply Done.', requestId: 'reconciliation-proof' }) });
    expect(response.status).toBe(200);
    const { taskId, conversationId } = await response.json() as { taskId: string; conversationId: string };
    await expect.poll(async () => {
      const view = await (await fetch(`${daemon!.url}/api/tasks/${taskId}/nodes/master/run`, { headers })).json();
      return view.operations.length > 0 && view.operations.every((item: { workerActive: boolean }) => !item.workerActive) && view.invocations.length > 0 && view.invocations.every((item: { cost: unknown }) => item.cost !== null);
    }, { timeout: 20000 }).toBe(true);
    // Failed turns can schedule host recovery after an individual operation
    // settles. Stop that owner through public controls before closing SQLite.
    for (const action of ['pause', 'interrupt']) {
      expect((await fetch(`${daemon.url}/api/conversations/${conversationId}/${action}`, { method: 'POST', headers,
        body: JSON.stringify({ requestId: `reconciliation-${action}` }) })).status).toBe(200);
    }
    await daemon.close(); daemon = undefined;
    const db = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try {
      const observations = db.prepare("SELECT data FROM events WHERE type='provider.transport'").all().map(row => JSON.parse(String(row.data)));
      expect(received.length).toBeGreaterThan(0);
      expect(new Set(received.map(r => r.id)).size).toBe(received.length);
      for (const request of received) {
        expect(request.id).toMatch(/^[0-9a-f-]{36}$/);
        const call = observations.filter(o => o.callId === request.id);
        expect(db.prepare('SELECT id FROM invocations WHERE id=?').get(request.id!)).toBeDefined();
        expect(call).toContainEqual(expect.objectContaining({ phase: 'fetch_started', requestSha256: request.hash }));
        if (variant === 'complete') expect(call).toContainEqual(expect.objectContaining({ phase: 'response_headers', status: 200, responseIds: { 'x-request-id': 'fixture-provider-request' } }));
        else if (variant === 'lost-before-headers') expect(call).toContainEqual(expect.objectContaining({ phase: 'transport_error', errorCodes: expect.arrayContaining(['UND_ERR_SOCKET']), usageRecoverableFromTransport: false }));
        else expect(call).toContainEqual(expect.objectContaining({ phase: 'response_headers', status: variant === 'proxy-503' ? 503 : 429 }));
      }
      expect(JSON.stringify(observations)).not.toMatch(/do-not-persist|authorization|set-cookie/i);
    } finally { db.close(); }
    const report = JSON.parse((await execute(process.execPath, ['scripts/harness-cost.mjs', join(root, 'state/tasks.sqlite')])).stdout);
    const task = report.tasks.find((t: { id: string }) => t.id === taskId);
    if (variant === 'complete') expect(task).toMatchObject({ unknownUsage: 0, estimatedUsage: 0, tokens: { input: 20, output: 7, cacheRead: 10, cacheWrite: 0 } });
    else {
      expect(task.unknownUsage).toBe(received.length);
      expect(report.summary.costPerCompletedTask).toBeNull();
    }
  } finally {
    await daemon?.close(); vendor.closeAllConnections(); await new Promise<void>(resolve => vendor.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
