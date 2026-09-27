import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

const script = join(process.cwd(), 'scripts', 'matt-flow.mjs');

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-matt-flow-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Run the checker the way the flow does, and read back both the report and the exit code. */
function run(root: string, args: string[]) {
  const result = spawnSync('node', [script, ...args, '--root', root], { encoding: 'utf8', env: process.env });
  return { code: result.status ?? -1, out: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const SPEC = `# 让暂停真的停住 Agent\n\n## 背景\n\n暂停按钮现在只影响排队，正在跑的主 Agent 回合仍会继续发出模型请求，\n使用者看到「已暂停」却仍在计费。\n\n## 范围\n\n暂停时软停正在跑的主 Agent 回合：当前工具调用收尾后不再发起新的模型请求；\n点「继续」自动接着跑被停下的那个回合；完全访问下同样生效。\n不新增依赖、不改 SDK、不改输入区的既有快捷键。\n\n## 验收\n\n真机上暂停一次、继续一次：暂停后该回合不再产生新的供应商调用，\n继续后同一个回合接着跑完，并留下可复查的记录。\n`;

async function spec(root: string, slug: string, text = SPEC) {
  await mkdir(join(root, 'docs', 'specs'), { recursive: true });
  await writeFile(join(root, 'docs', 'specs', `${slug}.md`), text);
}

async function tickets(root: string, issues: unknown[]) {
  const path = join(root, 'tickets.json');
  await writeFile(path, JSON.stringify(issues));
  return path;
}

test('a missing spec, an unlinked ticket and an uncited commit each fail on their own line', async () => {
  const root = await temp('stages');
  const missing = run(root, ['demo', '--stage', 'spec']);
  expect(missing.code).toBe(1);
  expect(missing.out).toContain('缺少规格文件 docs/specs/demo.md');

  await spec(root, 'demo', '# 太短\n');
  expect(run(root, ['demo', '--stage', 'spec']).out).toContain('字符（至少 200）');
  await spec(root, 'demo');

  // A ticket that never names the spec is not a ticket for this spec.
  const orphan = await tickets(root, [{ number: 7, title: '别的活', body: '无关', labels: [{ name: 'ready-for-agent' }] }]);
  expect(run(root, ['demo', '--stage', 'tickets', '--tickets', orphan]).out).toContain('没有任何 issue 提到');
  // Linked but untriaged is still refused: the flow needs a state, not just a link.
  const untriaged = await tickets(root, [{ number: 7, title: 'demo 的活', body: '见 docs/specs/demo.md', labels: [] }]);
  expect(run(root, ['demo', '--stage', 'tickets', '--tickets', untriaged]).out).toContain('都没有分诊标签');
  const good = await tickets(root, [{ number: 7, title: 'demo 的活', body: '见 docs/specs/demo.md', labels: [{ name: 'ready-for-agent' }] }]);
  const ticketed = run(root, ['demo', '--stage', 'tickets', '--tickets', good]);
  expect(ticketed.code).toBe(0);
  expect(ticketed.out).toContain('tickets: 1 条：#7');
});

test('the implement stage wants a commit that cites the ticket, and review wants the three of them', async () => {
  const root = await temp('implement');
  await spec(root, 'demo');
  const file = await tickets(root, [{ number: 7, title: 'demo 的活', body: '见 docs/specs/demo.md', labels: [{ name: 'ready-for-agent' }] }]);
  execFileSync('git', ['init', '--template=', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'chore: start without citing'], { cwd: root });
  expect(run(root, ['demo', '--stage', 'implement', '--tickets', file]).out).toContain('都没有引用任务号');
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'feat: stop the agent (#7)'], { cwd: root });
  const ok = run(root, ['demo', '--stage', 'implement', '--tickets', file]);
  expect(ok.out).toContain('implement: 引用到 #7');
  expect(ok.code).toBe(0);

  const review = run(root, ['demo', '--stage', 'review', '--tickets', file]);
  expect(review.out).toContain('review: 可审查');
  // Review refuses when an earlier stage is broken rather than reviewing nothing.
  execFileSync('git', ['reset', '-q', '--hard', 'HEAD~1'], { cwd: root });
  const blocked = run(root, ['demo', '--stage', 'review', '--tickets', file]);
  expect(blocked.code).toBe(1);
  expect(blocked.out).toContain('审查的前提未满足');
});

test('the json report is machine readable and the exit code carries the verdict', async () => {
  const root = await temp('json');
  await spec(root, 'demo');
  const ok = await tickets(root, [{ number: 3, title: 'demo', body: 'docs/specs/demo.md', labels: [{ name: 'needs-triage' }] }]);
  const passed = JSON.parse(run(root, ['demo', '--stage', 'tickets', '--tickets', ok, '--json']).out) as { ok: boolean; results: { name: string; ok: boolean }[] };
  expect(passed.ok).toBe(true);
  expect(passed.results.map(item => item.name)).toEqual(['spec', 'tickets']);

  const failed = JSON.parse(run(root, ['other', '--stage', 'spec', '--json']).out) as { ok: boolean; results: { detail: string }[] };
  expect(failed.ok).toBe(false);
  expect(failed.results[0]?.detail).toContain('docs/specs/other.md');
});
