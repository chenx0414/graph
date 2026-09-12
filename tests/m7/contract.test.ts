import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const script = fileURLToPath(new URL('../../examples/m7-contract.ts', import.meta.url));

function runContract(env: Record<string, string>) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('error', reject);
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

test('the contract check records reported model, text and usage for both ids', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-contract-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const requests: { model?: string }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    requests.push(body);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: body.model,
      choices: [{ message: { content: 'ready' } }],
      usage: { prompt_tokens: 25, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 5 } },
    }));
  });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const reportPath = join(parent, 'contract-report.json');
  const result = await runContract({
    GRAPH_M7_MODEL_BASE_URL: baseUrl, GRAPH_M7_MODEL_API_KEY: 'scripted-local-key',
    GRAPH_M7_MODEL_ID: 'local', GRAPH_M7_REVIEW_MODEL_ID: 'reader',
    GRAPH_M7_CONTRACT_REPORT: reportPath,
  });
  expect(result.code).toBe(0);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { checks: { id: string; ok: boolean; reportedModel: string; content: string; usage: { input: number; output: number; cacheRead: number } }[]; sameReportedModel: boolean };
  expect(requests.map(request => request.model)).toEqual(['local', 'reader']);
  expect(report.checks.map(check => ({ id: check.id, ok: check.ok, model: check.reportedModel, content: check.content }))).toEqual([
    { id: 'local', ok: true, model: 'local', content: 'ready' },
    { id: 'reader', ok: true, model: 'reader', content: 'ready' },
  ]);
  expect(report.checks[0]!.usage).toEqual({ input: 20, output: 2, cacheRead: 5, cacheWrite: 0 });
  expect(report.sameReportedModel).toBe(false);
  expect(result.stdout).not.toContain('scripted-local-key');
});

test('the contract check reports a failing model without hiding the other result', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-contract-fail-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { model?: string };
    if (body.model === 'reader') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'review model unavailable' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: 'ready' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }));
  });
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const reportPath = join(parent, 'contract-report.json');
  const result = await runContract({
    GRAPH_M7_MODEL_BASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    GRAPH_M7_MODEL_API_KEY: 'scripted-local-key',
    GRAPH_M7_MODEL_ID: 'local', GRAPH_M7_REVIEW_MODEL_ID: 'reader',
    GRAPH_M7_CONTRACT_REPORT: reportPath,
  });
  expect(result.code).toBe(1);
  const report = JSON.parse(await readFile(reportPath, 'utf8')) as { checks: { id: string; ok: boolean; problems: string[] }[] };
  expect(report.checks[0]).toMatchObject({ id: 'local', ok: true });
  expect(report.checks[1]!.ok).toBe(false);
  expect(report.checks[1]!.problems.join(' ')).toContain('review model unavailable');
});
