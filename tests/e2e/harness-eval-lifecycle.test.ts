import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openaiServer } from '../fixtures/openai-server.ts';

const execute = promisify(execFile);

test.each([true, false])('real evaluation CLI records terminal state and closes its ledger (timeout=%s)', async timedOut => {
  const root = await mkdtemp(join(tmpdir(), 'graph-eval-lifecycle-'));
  const provider = await openaiServer(timedOut
    ? [{ text: 'Too late', beforeReply: () => new Promise(resolve => setTimeout(resolve, 5_000)) }]
    : [{ tools: [{ id: 'repair', name: 'bash', arguments: JSON.stringify({ command: `if test -e ../case.json; then echo 'verification leaked' >&2; exit 1; fi
cat > config.js <<'EOF'
export function parseConfig(text) { return Object.fromEntries(text.split('\\n').filter(line => line.trim()).map(line => { const index = line.indexOf('='); return [line.slice(0,index),line.slice(index+1)]; })); }
EOF` }) }] }, { text: 'Fixed.' }]);
  let artifactRoot: string | undefined;
  try {
    const configPath = join(root, 'config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [],
      credentials: { local: { secretRef: 'GRAPH_EVAL_LOCAL_KEY' } },
      models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
        credentialId: 'local', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
      }] },
    }));
    const { stdout, stderr } = await execute(process.execPath, ['scripts/harness-real-eval.mjs', configPath], {
      cwd: process.cwd(), timeout: 30_000,
      env: { ...process.env, HOME: root, GRAPH_EVAL_LOCAL_KEY: 'fixture-key', GRAPH_EVAL_TIMEOUT_MS: timedOut ? '1000' : '15000' },
    });
    const report = JSON.parse(stdout);
    artifactRoot = report.root;
    expect(provider.requests.length).toBeGreaterThan(0);
    expect(report).toMatchObject({ completed: !timedOut, success: !timedOut, timedOut });
    expect(report.settled.state).toBe(timedOut ? 'interrupted' : 'succeeded');
    expect(report.cleanupIncomplete).toBe(false);
    expect(report.task.requests).toBeGreaterThan(0);
    expect(stderr).not.toMatch(/database is not open|ERR_INVALID_STATE/);
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
    if (artifactRoot) await rm(artifactRoot, { recursive: true, force: true });
  }
}, 40_000);
