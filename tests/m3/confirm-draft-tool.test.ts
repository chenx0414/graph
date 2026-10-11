import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentTools } from '../../src/runtime/agent-tools.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// HB-25: the confirmation card is a mechanism gate, not a judgement gate. When the
// user says so in chat, the master may confirm for them - but the record must show
// who really acted and carry the user's own words, so the transcript and the command
// log agree. These two tests hold that contract at the tool surface.
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-confirm-draft-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const seen: unknown[] = [];
  const tools = agentTools({
    workspace: dir,
    // Only the master role sees the graph-control tools, confirm_draft among them.
    role: 'master',
    supervisor: {
      confirmDraft: async (input: { proposalVersion: number; targetBranch: string; instruction: string; requestId: string }) => {
        seen.push(input);
        return { taskId: 't', targetBranch: input.targetBranch };
      },
    } as never,
  });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(item => item.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<unknown>)('probe', params);
  return { seen, call };
}

test('confirm_draft refuses to confirm without the user words that authorised it', async () => {
  const { seen, call } = await fixture();
  await expect(call('confirm_draft', { proposalVersion: 3, draftRevision: 1, targetBranch: 'main', instruction: '   ', requestId: 'r1' }))
    .rejects.toThrow(/instruction/i);
  expect(seen).toEqual([]);
});

test('confirm_draft passes the user words through to the runtime verbatim', async () => {
  const { seen, call } = await fixture();
  const instruction = '已确认草稿！main agent 可以代替用户点击确认草稿';
  const result = await call('confirm_draft', { proposalVersion: 3, draftRevision: 1, targetBranch: 'main', instruction, requestId: 'r2' });
  expect(seen).toEqual([{ proposalVersion: 3, draftRevision: 1, targetBranch: 'main', instruction, requestId: 'r2' }]);
  expect(JSON.stringify(result)).toContain('taskId');
});
