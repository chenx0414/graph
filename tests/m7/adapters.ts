import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { openTaskRuntime } from '../../src/core/task-runtime.ts';
import type { ActionAdapter, Operation } from '../../src/core/types.ts';
import { mediaBookmarksProposal } from './proposal.ts';

const payloadDir = fileURLToPath(new URL('../fixtures/m7/', import.meta.url));
const usage = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 };

type Runtime = Awaited<ReturnType<typeof openTaskRuntime>>;

async function copyPayload(workspace: string, from: string, to: string) {
  const dest = join(workspace, to);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(join(payloadDir, from), dest);
}

function requireWorkspace(operation: Operation) {
  if (!operation.workspace) throw new Error(`Node ${operation.nodeId} is missing an isolated work copy`);
  return operation.workspace;
}

function requireBriefing(operation: Operation) {
  const briefing = operation.context.briefing ?? '';
  if (!briefing.includes('login-status') || !briefing.includes('.browser-profile')) {
    throw new Error('Worker did not receive the frozen acceptance briefing');
  }
}

/** Scripted workers that write the frozen Bilibili web into Graph work copies. No paid model. */
export function mediaBookmarksActions(runtime: () => Runtime): Record<string, ActionAdapter> {
  return {
    master: {
      kind: 'agent',
      reserveTokens: 200,
      prepare: async operation => async () => {
        await runtime().supervisor(operation.taskId).propose(mediaBookmarksProposal(operation.requirementVersion), 'm7-plan');
        return { outcome: 'completed', output: { planned: true }, usage };
      },
    },
    'web-api': {
      kind: 'agent',
      reserveTokens: 200,
      prepare: async operation => async () => {
        requireBriefing(operation);
        const workspace = requireWorkspace(operation);
        await copyPayload(workspace, 'web-server.js', 'src/web-server.js');
        const pkgPath = join(workspace, 'package.json');
        const pkg = JSON.parse(await readFile(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
        await writeFile(pkgPath, `${JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, web: 'node src/web-server.js' } }, null, 2)}\n`);
        return { outcome: 'completed', output: { file: 'src/web-server.js' }, usage };
      },
    },
    'web-ui': {
      kind: 'agent',
      reserveTokens: 200,
      prepare: async operation => async () => {
        requireBriefing(operation);
        await copyPayload(requireWorkspace(operation), 'index.html', 'src/web/index.html');
        return { outcome: 'completed', output: { file: 'src/web/index.html' }, usage };
      },
    },
    'web-test': {
      kind: 'agent',
      reserveTokens: 200,
      prepare: async operation => async () => {
        requireBriefing(operation);
        await copyPayload(requireWorkspace(operation), 'web-server.test.js', 'test/web-server.test.js');
        return { outcome: 'completed', output: { file: 'test/web-server.test.js' }, usage };
      },
    },
    check: {
      kind: 'program',
      prepare: async operation => async () => {
        const root = requireWorkspace(operation);
        const result = spawnSync(process.execPath, ['--test', 'test/web-server.test.js'], {
          cwd: root,
          encoding: 'utf8',
          timeout: 12_000,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, GRAPH_FIXTURE: '1' },
        });
        const report = {
          ok: result.status === 0,
          status: result.status,
          stdout: result.stdout ?? '',
          stderr: result.stderr ?? '',
        };
        const path = join(root, 'output', 'graph-check.json');
        await mkdir(dirname(path), { recursive: true });
        const body = `${JSON.stringify(report, null, 2)}\n`;
        await writeFile(path, body);
        if (result.status !== 0) return { outcome: 'failed', output: report };
        const digest = createHash('sha256').update(body).digest('hex');
        const artifact = { path, digest };
        return {
          outcome: 'completed',
          output: report,
          evidence: [
            { acceptanceId: 'login-status', summary: 'Login status names exclusive .browser-profile', artifact },
            { acceptanceId: 'collect-progress', summary: 'Collect reports progress and a fixture failure reason', artifact },
            { acceptanceId: 'browse-notes', summary: 'Favorites and existing notes are listed', artifact },
            { acceptanceId: 'export-md', summary: 'Markdown export is nonempty', artifact },
          ],
        };
      },
    },
    review: {
      kind: 'agent',
      reserveTokens: 200,
      prepare: async operation => async () => {
        const workspace = requireWorkspace(operation);
        const server = await readFile(join(workspace, 'src/web-server.js'), 'utf8');
        const page = await readFile(join(workspace, 'src/web/index.html'), 'utf8');
        const test = await readFile(join(workspace, 'test/web-server.test.js'), 'utf8');
        const blockers = [
          !server.includes('.browser-profile') || !server.includes('collect_busy') ? 'web-api missing exclusive profile or collect lock' : '',
          !page.includes('只允许一个采集任务') ? 'web-ui missing exclusive collect copy' : '',
          !test.includes('GRAPH_FIXTURE') ? 'web-test missing fixture seam' : '',
          server.includes('typescript') || page.includes('vitest') ? 'target picked up Graph TypeScript toolchain' : '',
        ].filter(Boolean);
        const verdict = blockers.length ? 'reject' : 'pass';
        const body = ['# B站 Web 独立审查', '', `结论：${verdict}`, '', '审查实例未参与实现。确认独立 profile、不可并发采集、合成夹具测试，以及目标仍为 JavaScript。', blockers.length ? `阻塞：${blockers.join('; ')}` : ''].filter(Boolean).join('\n') + '\n';
        await mkdir(join(workspace, 'docs'), { recursive: true });
        await writeFile(join(workspace, 'docs/bilibili-web-review.md'), body);
        if (blockers.length) return { outcome: 'failed', output: { verdict, blockers }, usage };
        return { outcome: 'completed', output: { verdict }, usage };
      },
    },
  };
}
