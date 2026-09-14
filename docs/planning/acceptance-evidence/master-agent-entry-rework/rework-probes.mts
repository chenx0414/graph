// Rework evidence probe for ME-R01, ME-R03, ME-R04, ME-R06 and the
// conversation decision digest. Run from the delivery worktree:
//   ./node_modules/.bin/node docs/planning/acceptance-evidence/master-agent-entry-rework/rework-probes.mts
// Exit 0 means every check below passed; each check prints its observed JSON.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const repo = process.argv[2] ?? process.cwd();
const { openTaskRuntime } = await import(pathToFileURL(join(repo, 'src/core/task-runtime.ts')).href);
const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const checks: unknown[] = [];
let failed = false;
const record = (value: unknown) => { checks.push(value); console.log(JSON.stringify(value)); };
const check = (name: string, passed: boolean, detail: unknown) => { failed ||= !passed; record({ check: name, passed, ...((detail && typeof detail === 'object') ? detail : { detail }) }); };

const masterAction = (handler: (operation: unknown) => { outcome: 'completed'; output: { text: string }; usage: typeof usage | null }) => ({
  kind: 'agent' as const, reserveTokens: 100,
  prepare: async (operation: unknown) => async () => handler(operation),
});

async function withRuntime(root: string, handler: (operation: unknown) => { outcome: 'completed'; output: { text: string }; usage: typeof usage | null }, projects?: { id: string; root: string }[]) {
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    ...(projects ? { projects } : {}),
    actions: { master: masterAction(handler) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  return runtime;
}

// ME-R01: a message queued while the master is blocked on unknown usage is
// answered after either reconciliation mode, exactly once.
for (const type of ['usage', 'reconcile_usage'] as const) {
  const root = await mkdtemp(join(tmpdir(), 'rework-queued-'));
  let calls = 0;
  const counted = await openTaskRuntime({
    stateDir: join(root, 'state'),
    actions: { master: masterAction(() => {
      calls += 1;
      return calls === 1
        ? { outcome: 'completed' as const, output: { text: 'first' }, usage: null }
        : { outcome: 'completed' as const, output: { text: 'second' }, usage };
    }) },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  try {
    const created = await counted.conversations.create({ text: 'first message', requestId: 'create' });
    await counted.host.runReady();
    const before = await counted.conversations.view(created.conversationId);
    const question = before.questions.find(item => item.kind === 'unknown_usage' && item.status === 'open');
    if (!question) throw new Error('missing unknown-usage question');
    await counted.conversations.chat(created.conversationId, { text: 'second message', requestId: 'queue' });
    await counted.user.task(before.anchorTaskId).answer(question.id, type === 'usage' ? { type: 'usage', usage, proof: 'probe' } : { type: 'reconcile_usage', proof: 'probe' }, 'answer');
    await counted.host.runReady();
    const after = await counted.conversations.view(created.conversationId);
    check(`queued-message-after-${type}`, calls === 2 && after.messages.some(message => message.role === 'assistant' && message.text === 'second'),
      { providerTurns: calls, assistant: after.messages.filter(message => message.role === 'assistant').map(message => message.text), secondState: after.messages.find(message => message.text === 'second message')?.state });
  } finally { await counted.close(); await rm(root, { recursive: true, force: true }); }
}

// ME-R03: a draft investigated for project A cannot be confirmed after a
// rebind to project B, and a fresh draft for B can.
{
  const root = await mkdtemp(join(tmpdir(), 'rework-rebind-'));
  await mkdir(join(root, 'a'), { recursive: true });
  await mkdir(join(root, 'b'), { recursive: true });
  const runtime = await withRuntime(root, () => ({ outcome: 'completed' as const, output: { text: 'ok' }, usage }), [{ id: 'a', root: join(root, 'a') }, { id: 'b', root: join(root, 'b') }]);
  try {
    const created = await runtime.conversations.create({ projectId: 'a', text: 'improve A', requestId: 'create' });
    await runtime.host.runReady();
    const anchor = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    const draft = (requirementVersion: number, summary: string) => ({
      requirementVersion, summary,
      acceptance: [{ id: 'works', description: 'check passes', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'm' },
        { id: 'check', kind: 'program' as const, action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    });
    await runtime.supervisor(anchor).propose(draft(1, 'from A'), 'draft-a');
    await runtime.conversations.bind(created.conversationId, { projectId: 'b', requestId: 'rebind' });
    let rejected: string | null = null;
    try { await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm-a' }); }
    catch (error) { rejected = (error as { code?: string }).code ?? String(error); }
    const afterBind = await runtime.conversations.view(created.conversationId);
    await runtime.supervisor(anchor).propose(draft(2, 'from B'), 'draft-b');
    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 2, targetBranch: 'main', requestId: 'confirm-b' });
    const task = await runtime.user.task(confirmed.taskId).view();
    check('rebind-invalidates-draft', rejected === 'stale_proposal' && afterBind.projectId === 'b' && afterBind.proposal?.stale === true && task.projectId === 'b',
      { rejected, project: afterBind.projectId, stale: afterBind.proposal?.stale, confirmedProject: task.projectId });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}

// ME-R04: the default page shows the newest records; older history stays
// reachable through `before`, and `after` walks forward.
{
  const root = await mkdtemp(join(tmpdir(), 'rework-paging-'));
  const runtime = await withRuntime(root, () => ({ outcome: 'completed' as const, output: { text: 'ok' }, usage }));
  try {
    const created = await runtime.conversations.create({ text: 'message-000', requestId: 'create' });
    for (let index = 1; index <= 201; index++) await runtime.conversations.chat(created.conversationId, { text: `message-${String(index).padStart(3, '0')}`, requestId: `msg-${index}` });
    const page = await runtime.conversations.view(created.conversationId);
    const older = await runtime.conversations.view(created.conversationId, { before: page.messages[0]!.seq });
    const forward = await runtime.conversations.view(created.conversationId, { after: page.messages.at(-1)!.seq });
    check('message-pagination', page.messages.length === 200 && page.messages.at(-1)!.text === 'message-201' && older.messages.map(message => message.text).join(',') === 'message-000,message-001' && forward.messages.length === 0,
      { total: page.messageCount, pageFirst: page.messages[0]!.text, pageLast: page.messages.at(-1)!.text, older: older.messages.map(message => message.text), forward: forward.messages.length });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}

// ME-R06 + decision digest: an open unknown-usage question marks the cost
// unknown before any priced invocation, and confirmed tasks carry the
// conversation decisions to workers.
{
  const root = await mkdtemp(join(tmpdir(), 'rework-digest-'));
  await mkdir(join(root, 'project'), { recursive: true });
  let calls = 0;
  const seen: { context?: { briefing?: string } }[] = [];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: join(root, 'project') }],
    actions: {
      master: masterAction(() => { calls += 1; return calls === 1 ? { outcome: 'completed' as const, output: { text: 'first' }, usage: null } : { outcome: 'completed' as const, output: { text: 'next' }, usage }; }),
      work: { kind: 'agent' as const, reserveTokens: 100, prepare: async (operation: unknown) => { seen.push(operation as { context?: { briefing?: string } }); return async () => ({ outcome: 'completed' as const, output: { done: true }, usage }); } },
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'm' },
  });
  try {
    const created = await runtime.conversations.create({ text: '约束：预算有限，登录先不改。', requestId: 'create' });
    await runtime.host.runReady();
    const blocked = await runtime.conversations.view(created.conversationId);
    const unknownCost = blocked.cost.unknown === true && blocked.master?.cost.unknown === true;
    await runtime.user.task(blocked.anchorTaskId).answer(blocked.questions[0]!.id, { type: 'usage', usage, proof: 'probe' }, 'answer');
    await runtime.supervisor(blocked.anchorTaskId).propose({
      requirementVersion: 1, summary: 'minimal',
      acceptance: [{ id: 'works', description: 'check passes', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    }, 'draft');
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.runReady();
    const briefing = seen[0]?.context?.briefing ?? '';
    check('unknown-cost-and-decision-digest', unknownCost && briefing.includes('Decisions and constraints from the conversation') && briefing.includes('预算有限，登录先不改'),
      { unknownCost, digestPresent: briefing.includes('Decisions and constraints from the conversation') });
  } finally { await runtime.close(); await rm(root, { recursive: true, force: true }); }
}

process.exitCode = failed ? 1 : 0;
