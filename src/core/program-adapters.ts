import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitIntegration } from '../git/integration.ts';
import type { RestrictedGate } from '../runtime/restricted-process.ts';
import { openWorkspaceCommandRunner, validateWorkspaceCommand } from '../runtime/workspace-command.ts';
import { evaluateVerifier } from './verification.ts';
import type { TaskStore } from './store.ts';
import { RuntimeError, type ActionAdapter, type NodeSpec, type Proposal } from './types.ts';

function proposalFor(store: TaskStore, taskId: string, proposalVersion: number) {
  const row = store.db.prepare('SELECT spec FROM proposals WHERE task_id=? AND version=?')
    .get(taskId, proposalVersion) as { spec: string } | undefined;
  if (!row) throw new RuntimeError('not_found', 'Proposal not found');
  return JSON.parse(row.spec) as Proposal;
}

export function graphVerifier(store: TaskStore, spec: NodeSpec): ActionAdapter {
  return {
    kind: 'program',
    prepare: async operation => async () => {
      if (!spec.verifier) throw new RuntimeError('invalid_adapter', 'graph.verify requires a verifier config');
      const proposal = proposalFor(store, operation.taskId, operation.proposalVersion);
      const acceptanceIds = proposal.acceptance
        .filter(item => item.checkNode === operation.nodeId)
        .map(item => item.id);
      try {
        return evaluateVerifier(spec.verifier, {
          dependencies: operation.dependencies,
          dependencySources: operation.dependencySources,
          acceptanceIds,
        });
      } catch (error) {
        if (error instanceof RuntimeError && error.code === 'invalid_evidence') {
          return {
            outcome: 'completed',
            output: {
              kind: 'verification',
              outcome: 'rework',
              subjects: [],
              reports: [],
              blockers: [{ id: 'invalid_evidence', reason: error.message, evidence: [] }],
            },
          };
        }
        throw error;
      }
    },
  };
}

export function workspaceCommandNode(input: {
  store: TaskStore;
  spec: NodeSpec;
  git?: GitIntegration;
  scratchRoot?: string;
  program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
  stopped: () => boolean;
}): ActionAdapter {
  const { store, spec } = input;
  return {
    kind: 'program',
    prepare: async operation => {
      const command = spec.input as { command?: unknown; args?: unknown } | null;
      if (!command || typeof command.command !== 'string'
        || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) {
        throw new RuntimeError('invalid_adapter', 'graph.command requires input {command, args}');
      }
      validateWorkspaceCommand(command.command, command.args);
      const root = (store.db.prepare('SELECT root FROM projects WHERE id=?')
        .get(store.task(operation.taskId).project_id) as { root: string } | undefined)?.root;
      // Non-git projects have no work copy; their agent instances work in the
      // project root, so the confirmed check runs there too.
      const workspace = operation.workspace ?? (root && !input.git?.repoRoot(operation.taskId) ? root : undefined);
      if (!workspace) throw new RuntimeError('invalid_adapter', 'graph.command requires a work copy');
      return async () => {
        if (input.program?.nodeModulesPath) {
          const link = join(workspace, 'node_modules');
          if (!existsSync(link)) {
            try { await symlink(await realpath(input.program.nodeModulesPath), link, 'dir'); }
            catch { /* The check reports its own resolution failure. */ }
          }
        }
        const gate: RestrictedGate = {
          dispatch: (_id, _reservation, send) => {
            if (input.stopped() || store.task(operation.taskId).paused) {
              throw new RuntimeError('paused', 'Task paused');
            }
            return send();
          },
          settle: () => {},
        };
        const extraReads = input.program?.readPaths
          ? (await Promise.all(input.program.readPaths.map(path => realpath(path).catch(() => undefined))))
              .filter((path): path is string => path !== undefined)
          : [];
        const runner = await openWorkspaceCommandRunner({
          workspace,
          scratchDir: join(input.scratchRoot ?? workspace, 'checks', operation.id),
          gate,
          localNetwork: true,
          ...(extraReads.length ? { readPaths: extraReads } : {}),
          ...(input.program?.env ? { env: input.program.env } : {}),
        });
        try {
          const result = await runner.run(command.command as string, command.args as string[]);
          const proposal = proposalFor(store, operation.taskId, operation.proposalVersion);
          const acceptanceIds = proposal.acceptance
            .filter(item => item.checkNode === operation.nodeId)
            .map(item => item.id);
          const body = `${JSON.stringify({
            command: command.command,
            args: command.args,
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
          }, null, 2)}\n`;
          const dir = join(input.scratchRoot ?? workspace, 'checks');
          mkdirSync(dir, { recursive: true });
          const path = join(dir, `${operation.nodeId}.json`);
          writeFileSync(path, body);
          const digest = createHash('sha256').update(body).digest('hex');
          if (result.code !== 0) {
            return { outcome: 'failed', output: { code: result.code, stderr: result.stderr.slice(-4_000) } };
          }
          return {
            outcome: 'completed',
            output: { code: result.code },
            evidence: acceptanceIds.map(id => ({
              acceptanceId: id,
              summary: `Command exited 0: ${command.command}`,
              artifact: { path, digest },
            })),
          };
        } finally {
          await runner.close();
        }
      };
    },
  };
}

export function humanCheckNode(store: TaskStore): ActionAdapter {
  return {
    kind: 'program',
    prepare: async operation => async () => {
      const proposal = proposalFor(store, operation.taskId, operation.proposalVersion);
      const root = operation.workspace
        ?? (store.db.prepare('SELECT root FROM projects WHERE id=?')
          .get(store.task(operation.taskId).project_id) as { root: string }).root;
      const dir = join(root, '.graph');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `${operation.nodeId}.txt`);
      writeFileSync(path, 'acknowledged');
      const digest = createHash('sha256').update('acknowledged').digest('hex');
      return {
        outcome: 'completed' as const,
        output: { acknowledged: true },
        evidence: proposal.acceptance
          .filter(item => item.checkNode === operation.nodeId)
          .map(item => ({
            acceptanceId: item.id,
            summary: 'Human check acknowledged',
            artifact: { path, digest },
          })),
      };
    },
  };
}
