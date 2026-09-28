import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { selectModel, type ModelEntry } from '../catalog/models.ts';
import { resolveAccessPolicy, type AccessPolicy, type ResolvedAccessPolicy } from './access-policy.ts';
import type { TaskStore } from './store.ts';
import { RuntimeError } from './types.ts';
import { openAgentContextAssembly } from '../runtime/agent-context-assembly.ts';
import type { AgentContextLibrary } from '../runtime/agent-context.ts';
import { linkProjectDependencies } from '../runtime/project-dependencies.ts';
import { openWorkspaceCommandRunner } from '../runtime/workspace-command.ts';
import { createInProcessAgentSessionTransport, type AgentSessionTransport, type AgentSession } from '../runtime/agent-session.ts';
import { controlledOpenAIStream, type SendGate } from '../runtime/controlled-openai.ts';
import { guardHandoffResponses } from '../runtime/handoff-response.ts';
import { toPiModel } from '../runtime/pi-adapter.ts';
import { agentTools } from '../runtime/agent-tools.ts';

/**
 * Running the merge Agent.
 *
 * A collision between two lanes is resolved by an Agent that reads both sides and writes the
 * merge. It is deliberately a *separate* identity (`matt-merge`) rather than one of the colliding
 * lanes: whoever wrote one side should not be the one deciding what "both sides" means.
 *
 * The agent works in the task's integration worktree, the one place both sides exist together,
 * and the harness judges its result - this module only produces the turn.
 *
 * ## The settings, and where they came from
 *
 * The user chose them explicitly (2026-09-28): a **medium** model, an **unlimited** budget and
 * **full access**. They are not defaults to be quietly changed later. Medium is the grade the
 * `matt-merge` recipe recommends, and full access is what lets the turn use the tooling it needs
 * inside the integration checkout.
 *
 * ## What this turn does *not* do
 *
 * It is not an operation, so it takes no execution slot, writes no budget ledger row and produces
 * no evidence. Its token use is therefore **not** charged to the task. With an unlimited budget
 * that is invisible here, but it is a real gap and is recorded in the harness backlog rather than
 * assumed away.
 */

/** The identity a merge turn runs under. Its body is the merge discipline (see docs/agents/matt-flow.md). */
export const MERGE_DEFINITION_ID = 'matt-merge';

/** The grade the merge Agent runs at, as the user chose. */
export const MERGE_GRADE: ModelEntry['grade'] = 'medium';

export interface MergeResolverOptions {
  store: TaskStore;
  catalog: Catalog;
  instancesDir: string;
  directory: () => ModelEntry[];
  modelRuntime: ModelRuntime;
  /** The access policy in force. The resolver requires full access to run. */
  access: () => AccessPolicy;
  transport?: AgentSessionTransport;
  apiKeyFor?: (entry: ModelEntry) => string | undefined;
  /**
   * The prompt library the identity is resolved from. Without it a merge turn would run with an
   * empty identity and Pi would fill in a generic worker line, so the merge discipline - the part
   * that says a dropped side is not a merge - would silently be absent. It is required.
   */
  library: AgentContextLibrary;
}

export interface MergeTurnInput {
  taskId: string;
  nodeId: string;
  prompt: string;
  /** The integration worktree: the only directory where both sides of the collision exist. */
  workspace: string;
}

/**
 * What a merge turn cost, so the spend is visible even though the turn is not an operation.
 *
 * This is the honest half of "unlimited budget": the merge is not charged to the task's cap, but
 * it is recorded, because a spend nobody can see is the defect this type exists to avoid.
 */
export interface MergeTurnUsage {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export type MergeResolver = (input: MergeTurnInput) => Promise<MergeTurnUsage | null>;

export function createMergeResolver(options: MergeResolverOptions): MergeResolver {
  const transport = options.transport ?? createInProcessAgentSessionTransport({ modelRuntime: options.modelRuntime });
  return async input => {
    const entry = selectModel({ grade: MERGE_GRADE, directory: options.directory() });
    if (!entry) {
      throw new RuntimeError('model_unavailable', `No configured model can serve the ${MERGE_GRADE} grade the merge Agent needs`);
    }
    // A merge turn is not charged to the task's budget, so under a finite cap it would spend
    // quota that no ledger accounts for. Refusing keeps the cap honest; the task blocks exactly
    // as it did before this feature existed.
    if (!taskBudgetIsUnlimited(options.store, input.taskId)) {
      throw new RuntimeError(
        'budget',
        'The task has a finite token budget, and a merge turn is not charged to it; resolve this collision by hand or raise the budget',
      );
    }
    const definition = mergeDefinition(options.catalog);
    const apiKey = options.apiKeyFor?.(entry);
    const access = mergeAccessPolicy(options);
    const workspace = await realpath(input.workspace);
    const projectRoot = projectRootFor(options.store, input.taskId);

    const contextAssembly = await openAgentContextAssembly({
      catalog: options.catalog,
      definitionVersion: definition,
      action: 'merge',
      role: 'worker',
      workspace,
      ...(projectRoot ? { skillProjectRoot: projectRoot } : {}),
      fullAccess: true,
      retrieval: false,
      library: options.library,
    });
    const bundle = contextAssembly.bundle;
    const scratchRoot = join(options.instancesDir, `merge-${input.taskId}`);

    let commands: Awaited<ReturnType<typeof openWorkspaceCommandRunner>> | undefined;
    let session: AgentSession | undefined;
    let capabilityOperation: Awaited<ReturnType<typeof bundle.openOperation>> | undefined;
    // Nothing external is waiting on this turn, so it admits its own calls and settles them here.
    let usage: MergeTurnUsage | null = null;
    const gate = mergeGate(entry.id, collected => { usage = collected; });
    try {
      const dependencies = projectRoot
        ? await linkProjectDependencies(workspace, join(projectRoot, 'node_modules'))
        : null;
      commands = await openWorkspaceCommandRunner({
        workspace,
        scratchDir: join(scratchRoot, 'command-scratch'),
        gate,
        access,
        ...(dependencies ? { readPaths: [dependencies] } : {}),
      });
      capabilityOperation = await bundle.openOperation({
        workspace,
        scratchDir: join(scratchRoot, 'capability-scratch'),
        gate,
        action: 'merge',
        role: 'worker',
        access,
        disabledTools: contextAssembly.disabledTools,
        // The tool surface is built here exactly as the dispatcher builds it: the same
        // `agentTools` host surface, granted the read roots this operation resolved.
        hostTools: ({ readRoots }) => agentTools({
          workspace,
          role: 'worker',
          access,
          run: (command: string, args: string[]) => commands!.run(command, args),
          ...(readRoots.length ? { readRoots: [...readRoots] } : {}),
        }),
      });
      session = await transport.open({
        binding: { instanceId: `merge-${input.taskId}`, nodeId: input.nodeId, definitionVersion: definition },
        workspace,
        stateDir: scratchRoot,
        model: toPiModel(entry),
        stream: guardHandoffResponses(
          controlledOpenAIStream(gate, () => apiKey ?? '', undefined, entry.api, {}),
          { enabled: () => false, onRecovery: () => undefined },
        ),
        tools: [...capabilityOperation.tools],
        allowedToolNames: [...capabilityOperation.allowedToolNames],
        ...(capabilityOperation.readRoots.length ? { readRoots: [...capabilityOperation.readRoots] } : {}),
        ...(capabilityOperation.writeRoots.length ? { writeRoots: [...capabilityOperation.writeRoots] } : {}),
        ...(Object.keys(capabilityOperation.env).length ? { env: { ...capabilityOperation.env } } : {}),
        // Full access: the merge turn reads and writes the integration worktree as the harness does.
        filesystemAccess: 'host',
        protectedPaths: access.protectedPaths,
        allowGitMetadataWritesAll: access.filesystem.gitMetadata === 'writable',
        systemPrompt: capabilityOperation.prompts.system,
        ...(bundle.skillFolder ? { skillFolder: bundle.skillFolder } : {}),
        ...(capabilityOperation.skillPaths.length ? { skillPaths: [...capabilityOperation.skillPaths] } : {}),
        bundleDigest: capabilityOperation.bundleDigest,
        toolPolicyDigest: capabilityOperation.toolPolicyDigest,
        runtimePolicyDigest: capabilityOperation.runtimePolicyDigest,
        broker: gate,
      });
      await session.prompt(input.prompt);
      return usage;
    } finally {
      await session?.close().catch(() => undefined);
      await commands?.close().catch(() => undefined);
      await capabilityOperation?.close().catch(() => undefined);
    }
  };
}

/**
 * The access policy a merge turn runs under.
 *
 * Full access is a requirement, not a preference: the merge agent must read both sides and write
 * the resolution inside a checkout the harness itself owns. Anything narrower would make a
 * collision unresolvable, so it is refused rather than attempted with a policy that cannot work.
 */
export function mergeAccessPolicy(options: MergeResolverOptions): ResolvedAccessPolicy {
  const configured = options.access();
  if (configured.mode !== 'full') {
    throw new RuntimeError(
      'permission',
      'The merge Agent requires full access; without it the integration worktree cannot be written',
    );
  }
  return resolveAccessPolicy(configured, {
    home: resolve(options.instancesDir, '..', '..'),
    stateDir: dirname(options.instancesDir),
    graphHome: resolve(options.instancesDir, '..', '..'),
  });
}

/**
 * The gate for a turn no operation owns: it admits every call and settles nothing against a cap.
 *
 * A merge is not the work the task's budget was set for, so it is not charged to it - but every
 * settled call is summed and handed back to the caller, which records it on the task. The spend is
 * therefore visible even though it is not capped, and under a finite cap the turn is refused
 * outright (see `taskBudgetIsUnlimited`).
 */
function mergeGate(model: string, onUsage: (usage: MergeTurnUsage) => void): SendGate {
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  return {
    dispatch: (_id: string, _reservation: unknown, send: () => unknown) => send(),
    // Every settled call is added up here: the merge turn usually sends once, but a retry inside
    // the same turn must be counted too, or the number reported would understate the real spend.
    settle: (_id: string, reported: { input: number; output: number; cacheRead?: number; cacheWrite?: number } | null) => {
      if (!reported) return;
      totals.input += reported.input;
      totals.output += reported.output;
      totals.cacheRead += reported.cacheRead ?? 0;
      totals.cacheWrite += reported.cacheWrite ?? 0;
      onUsage({
        model,
        ...totals,
        total: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
      });
    },
  } as unknown as SendGate;
}

/** The published merge identity, or a refusal naming what is missing. */
export function mergeDefinition(catalog: Catalog): string {
  const matches = catalog.listDefinitions().filter(item => item.id === MERGE_DEFINITION_ID);
  const latest = matches.sort((left, right) => right.version - left.version)[0];
  if (!latest) {
    throw new RuntimeError(
      'definition_missing',
      `The merge Agent recipe ${MERGE_DEFINITION_ID} is not published; create it before a collision can be resolved`,
    );
  }
  return `${latest.id}@${latest.version}`;
}

/**
 * Whether every instance of this task is uncapped.
 *
 * `unlimited` is the instance's own flag, set with its budget. A task whose instances are all
 * uncapped has nothing to overspend, so the merge turn is free to run; one finite instance makes
 * the turn refuse, because its cost would not appear in any cap.
 */
export function taskBudgetIsUnlimited(store: TaskStore, taskId: string): boolean {
  const row = store.db.prepare(`SELECT COUNT(*) AS finite FROM instances i
    JOIN nodes n ON n.task_id=i.task_id AND n.id=i.node_id
    WHERE n.task_id=? AND i.unlimited=0`).get(taskId) as { finite: number } | undefined;
  return (row?.finite ?? 0) === 0;
}

function projectRootFor(store: TaskStore, taskId: string): string | null {
  const row = store.db.prepare('SELECT p.root AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?')
    .get(taskId) as { root: string } | undefined;
  return row?.root ?? null;
}
