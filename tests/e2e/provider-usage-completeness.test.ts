import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';

const execute = promisify(execFile);
// External Messages API faults; all application transport, SDK, persistence and reporting are real.
test.each(['complete', 'updated-input', 'truncated', 'invalid-delta', 'missing-output'] as const)(
  'HTTP conversation only bills complete Anthropic usage as authoritative: %s', async variant => {
    const root = await mkdtemp(join(tmpdir(), 'graph-usage-completeness-'));
    let requests = 0;
    const provider = createServer(async (request, response) => {
      for await (const _chunk of request) { /* consume the actual SDK request */ }
      requests++;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        { type: 'message_start', message: { id: 'usage-proof', type: 'message', role: 'assistant', model: 'local', content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 25, output_tokens: 1, cache_read_input_tokens: 15, cache_creation_input_tokens: 5 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Usage proof.' } },
        { type: 'content_block_stop', index: 0 },
        ...(variant === 'truncated' ? [] : [
          { type: 'message_delta', delta: { stop_reason: null }, usage: { output_tokens: 8 } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: variant === 'invalid-delta'
            ? { output_tokens: 'invalid' } : variant === 'missing-output' ? {} : variant === 'updated-input'
              ? { input_tokens: 30, output_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 7 } : { output_tokens: 10 } },
          { type: 'message_stop' },
        ]),
      ];
      for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    });
    await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
    let daemon: Awaited<ReturnType<typeof startGraphDaemon>> | undefined;
    try {
      const webDir = join(root, 'web'); await mkdir(webDir);
      await writeFile(join(webDir, 'index.html'), '<!doctype html>Graph');
      const configPath = join(root, 'config.json');
      await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_USAGE_KEY' } }, models: { entries: [{
        id: 'local', modelId: 'local', provider: 'graph-anthropic', grade: 'high', api: 'anthropic-messages',
        baseUrl: `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
        cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
        pricing: { currency: 'USD', unit: 'per_million_tokens', status: 'known', sourceUrl: 'fixture', retrievedAt: '2026-10-19' },
      }] } }));
      daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true,
        env: { HOME: root, GRAPH_USAGE_KEY: 'external-fixture-only' }, log: () => undefined });
      const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
      const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
      const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers,
        body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Reply Usage proof.', requestId: 'usage-proof' }) });
      expect(response.status).toBe(200);
      const { taskId } = await response.json() as { taskId: string };
      await expect.poll(async () => {
        const view = await (await fetch(`${daemon!.url}/api/tasks/${taskId}/nodes/master/run`, { headers })).json();
        return view.operations.some((item: { workerActive: boolean }) => !item.workerActive) && view.invocations.length > 0 && view.invocations.every((item: { cost: unknown }) => item.cost !== null);
      }, { timeout: 20000 }).toBe(true);
      await daemon.close(); daemon = undefined;
      const report = JSON.parse((await execute(process.execPath, ['scripts/harness-cost.mjs', join(root, 'state', 'tasks.sqlite')])).stdout);
      const task = report.tasks.find((item: { id: string }) => item.id === taskId);
      // Count actual external sends independently: EOF can invoke existing recovery.
      expect(requests).toBeGreaterThan(0);
      if (variant !== 'truncated') expect(requests).toBe(1);
      expect(task.requests).toBe(requests);
      if (variant === 'complete' || variant === 'updated-input') {
        expect(task).toMatchObject({ unknownUsage: 0, estimatedUsage: 0, unknownCost: 0, tokens: variant === 'complete'
          ? { input: 25, output: 10, cacheRead: 15, cacheWrite: 5 } : { input: 30, output: 10, cacheRead: 20, cacheWrite: 7 } });
        expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(1);
      } else {
        expect(task.unknownUsage + task.estimatedUsage).toBe(requests);
        expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(0);
        expect(report.summary.costPerCompletedTask).toBeNull();
      }
    } finally {
      await daemon?.close();
      provider.closeAllConnections(); await new Promise<void>(resolve => provider.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 30000,
);
