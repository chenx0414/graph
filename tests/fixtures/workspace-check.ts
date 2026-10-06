import type { ActionAdapter } from '../../src/core/types.ts';
import { join } from 'node:path';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import type { GraphDefinition } from '../../src/core/interface-spec.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';

/** A real native operation graph. No legacy proposal or supplied check receipt; optional main stays outside the graph. */
export async function runWorkspaceCheck(input: { workspace: string; command: unknown; fullAccess?: boolean; mainAction?: ActionAdapter }) {
  const runtime = await openTaskRuntime({
    stateDir: join(input.workspace, 'state'), projects: [{ id: 'project', root: input.workspace }],
    ...(input.fullAccess ? { access: () => fullAccessPolicy() } : {}),
    ...(input.mainAction ? { actions: { master: input.mainAction }, master: { action: 'master', definitionVersion: 'master@1', model: 'scripted' } } : {}),
  });
  try {
    let ownerTaskId: string;
    if (input.mainAction) {
      const conversation = await runtime.conversations.create({ text: 'Run the check', requestId: 'conversation' });
      await runtime.conversations.bind(conversation.conversationId, { projectId: 'project', requestId: 'bind' });
      ownerTaskId = (await runtime.conversations.view(conversation.conversationId)).anchorTaskId;
    } else ownerTaskId = (await runtime.user.begin({ projectId: 'project', request: 'Run the check', requestId: 'begin' })).taskId;
    const main = runtime.supervisor(ownerTaskId);
    const definition = {
      schemaVersion: 2, name: 'Workspace check', protocols: { value: { type: 'object' } }, nodes: {},
      modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'value' } }, outputs: { result: { protocol: 'value' } },
        operation: { action: 'workspace.command', version: 1, ...input.command as Record<string, unknown>, output: 'result' } } },
      edges: {}, inputs: {}, outputs: { result: { from: 'check.result', protocol: 'value' } },
      // Malformed command fields deliberately reach the real creation validator unchanged.
    } as unknown as GraphDefinition;
    const graph = await main.graphCreate({ definition, requestId: 'create' }) as { graphId: string };
    await main.graphSend({ graphId: graph.graphId, nodeId: 'check', input: 'start', value: {} });
    await runtime.host.drive();
    return { runtime, main, graphId: graph.graphId, root: input.workspace };
  } catch (error) { await runtime.close(); throw error; }
}

export type WorkspaceCheck = Awaited<ReturnType<typeof runWorkspaceCheck>>;
export interface WorkspaceCheckOutput { passed: boolean; code: number | null; stdout: string; stderr: string; record: string }

export async function workspaceCheckOutput(check: WorkspaceCheck): Promise<WorkspaceCheckOutput> {
  const operations = await check.main.graphInspect({ graphId: check.graphId, query: 'operations' }) as
    { state: string; result: { outputs: { result: WorkspaceCheckOutput } } | null }[];
  if (operations.length !== 1 || operations[0]!.state !== 'settled' || !operations[0]!.result) throw new Error('Check has no settled native operation result');
  return operations[0]!.result!.outputs.result;
}
