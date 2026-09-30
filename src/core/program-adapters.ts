import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { GitIntegration } from '../git/integration.ts';
import type { RestrictedGate } from '../runtime/restricted-process.ts';
import { openWorkspaceCommandRunner, resolveUnsandboxedCommand, validateWorkspaceCommand, type CommandResult } from '../runtime/workspace-command.ts';
import { runHostCommand, checkEnvironment } from '../runtime/host-command.ts';
import { linkProjectDependencies } from '../runtime/project-dependencies.ts';
import { prepareProjectCopy } from '../runtime/program-copy.ts';
import { evaluateVerifier } from './verification.ts';
import type { TaskStore } from './store.ts';
import { isFullAccess } from './access-policy.ts';
import { RuntimeError, type ActionAdapter, type NodeSpec, type Proposal } from './types.ts';

/** The longest a program check may be told to run: a day. */
const MAX_CHECK_TIMEOUT_MS = 86_400_000;

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
      // The files any node already declares, so the gate can name what nobody owns yet.
      const owned = (store.db.prepare('SELECT spec FROM nodes WHERE task_id=?').all(operation.taskId) as { spec: string }[])
        .flatMap(row => {
          try {
            const node = JSON.parse(row.spec) as NodeSpec;
            const input = node.input && typeof node.input === 'object' && !Array.isArray(node.input) ? node.input as Record<string, unknown> : null;
            const files = input?.['files'];
            return Array.isArray(files) ? files.filter((item): item is string => typeof item === 'string') : [];
          } catch { return []; }
        });
      try {
        return evaluateVerifier(spec.verifier, {
          dependencies: operation.dependencies,
          dependencySources: operation.dependencySources,
          acceptanceIds,
          owned,
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
      const command = spec.input as { command?: unknown; args?: unknown; copy?: unknown; timeoutMs?: unknown; sandbox?: unknown } | null;
      if (!command || typeof command.command !== 'string'
        || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== 'string')) {
        throw new RuntimeError('invalid_adapter', 'graph.command requires input {command, args}');
      }
      // A check that runs the project's own suite takes minutes, and the default limit cut it at two.
      // The limit is the node's to declare, up to a day; anything else is refused rather than
      // quietly replaced, because a check that silently ran under a different limit would pass or
      // fail for a reason its author never wrote down.
      if (command.timeoutMs !== undefined
        && (typeof command.timeoutMs !== 'number' || !Number.isSafeInteger(command.timeoutMs)
          || command.timeoutMs < 1 || command.timeoutMs > MAX_CHECK_TIMEOUT_MS)) {
        throw new RuntimeError('invalid_adapter', `graph.command timeoutMs must be a whole number of milliseconds between 1 and ${MAX_CHECK_TIMEOUT_MS}`);
      }
      const timeoutMs = command.timeoutMs as number | undefined;
      if (command.copy !== undefined && command.copy !== 'project') {
        throw new RuntimeError('invalid_adapter', "graph.command copy must be 'project' when given");
      }
      const projectCopy = command.copy === 'project';
      // A check may declare that it runs outside the OS sandbox. That is honoured only under full
      // access, and refused otherwise rather than quietly run sandboxed: the declaration comes from
      // the confirmed graph, and under full access an Agent can already run host commands, so the
      // sandbox was the stronger constraint than the thing it was proving - measured 2026-09-30, the
      // project's own suite passes 1480/1480 outside it and 224/49 inside it on the same copy. An
      // author who wrote `sandbox: false` must never be handed a run that silently did something
      // else; why the isolation is narrower here is in `runtime/host-command.ts`.
      if (command.sandbox !== undefined && typeof command.sandbox !== 'boolean') {
        throw new RuntimeError('invalid_adapter', 'graph.command sandbox must be true or false when given');
      }
      const unsandboxed = command.sandbox === false;
      if (unsandboxed && !isFullAccess(operation.accessPolicy)) {
        throw new RuntimeError('permission', 'graph.command sandbox:false requires full access: outside it a confirmed check must stay in the OS sandbox');
      }
      if (operation.accessPolicy?.commands !== 'host') validateWorkspaceCommand(command.command, command.args);
      const root = (store.db.prepare('SELECT root FROM projects WHERE id=?')
        .get(store.task(operation.taskId).project_id) as { root: string } | undefined)?.root;
      // Non-git projects have no work copy; their agent instances work in the
      // project root, so the confirmed check runs there too.
      const workspace = operation.workspace ?? (root && !input.git?.repoRoot(operation.taskId) ? root : undefined);
      if (!workspace) throw new RuntimeError('invalid_adapter', 'graph.command requires a work copy');
      // A confirmed check runs the project's own toolchain (`node --run check`:
      // tsc, vitest, a headless browser), while work copies stay
      // dependency-free. The host may select the link; otherwise the project
      // root - host configuration, never worker or proposal input - provides it.
      const modulesPath = input.program?.nodeModulesPath ?? (root ? join(root, 'node_modules') : undefined);
      // A check that runs the project's own command - its suite, its own entry
      // point - declares `copy: 'project'` and runs in a prepared worktree beside
      // the project root instead of under the host's state directory: that suite
      // reads sibling repositories next to the project root and needs the
      // dependencies to be ordinary files, not a link. Why, exactly, is in
      // runtime/program-copy.ts. The node's work copy stays the one the harness
      // manages; only where the command runs changes.
      if (projectCopy && !root) throw new RuntimeError('invalid_adapter', 'graph.command copy requires a project root');
      return async () => {
        const prepared = projectCopy && root
          ? await prepareProjectCopy({ projectRoot: root, source: workspace, label: operation.nodeId })
          : undefined;
        if (projectCopy && !prepared) {
          throw new RuntimeError('invalid_adapter', 'graph.command copy needs a work copy with a committed version');
        }
        const runRoot = prepared ?? workspace;
        // The prepared copy holds the dependencies as ordinary files inside its
        // own tree, so there is nothing outside it to grant.
        const modules = prepared ? undefined : await linkProjectDependencies(workspace, modulesPath);
        const gate: RestrictedGate = {
          dispatch: (_id, _reservation, send) => {
            if (input.stopped() || store.task(operation.taskId).paused) {
              throw new RuntimeError('paused', 'Task paused');
            }
            return send();
          },
          settle: () => {},
        };
        // The linked dependencies live outside the work copy, so the sandbox
        // needs a read grant for them as well.
        const extraReads = (await Promise.all([...(input.program?.readPaths ?? []), ...(modules ? [modules] : [])]
          .map(path => realpath(path).catch(() => undefined))))
          .filter((path): path is string => path !== undefined);
        // The check runs in the OS sandbox, which grants writes only under the
        // workspace and this scratch directory, so its temporary files must live
        // there too: a host TMPDIR such as /var/folders is denied even in host
        // mode, and any test that creates a temporary directory would fail (a real
        // check failed exactly this way when git init tried to write .git/config
        // inside its temporary repository). A caller-declared TMPDIR still wins,
        // because the sandbox spreads command.env over its computed TMPDIR.
        const checkScratch = join(input.scratchRoot ?? workspace, 'checks', operation.id);
        const checkEnv = { ...(input.program?.env ?? {}), TMPDIR: input.program?.env?.TMPDIR ?? checkScratch };
        const limit = timeoutMs === undefined ? {} : { timeoutMs };
        const run = async (): Promise<CommandResult> => {
          if (unsandboxed) {
            // Out of the sandbox, in the same directory and with a deliberately built environment: the
            // host's own PATH, HOME and locale, but not the app's environment, which is not the
            // check's business. The declared TMPDIR rule stays with the sandbox, which needs it.
            const resolved = resolveUnsandboxedCommand(command.command as string, command.args as string[]);
            const env = checkEnvironment({
              executable: resolved.executable,
              declared: { ...(input.program?.env ?? {}), ...(resolved.env ?? {}) },
              host: process.env,
            });
            return runHostCommand({ cwd: runRoot, executable: resolved.executable, args: resolved.args, env, ...limit });
          }
          // The linked dependencies live outside the work copy, so the sandbox
          // needs a read grant for them as well.
          const extraReads = (await Promise.all([...(input.program?.readPaths ?? []), ...(modules ? [modules] : [])]
            .map(path => realpath(path).catch(() => undefined))))
            .filter((path): path is string => path !== undefined);
          // The check runs in the OS sandbox, which grants writes only under the
          // workspace and this scratch directory, so its temporary files must live
          // there too: a host TMPDIR such as /var/folders is denied even in host
          // mode, and any test that creates a temporary directory would fail (a real
          // check failed exactly this way when git init tried to write .git/config
          // inside its temporary repository). A caller-declared TMPDIR still wins,
          // because the sandbox spreads command.env over its computed TMPDIR.
          const runner = await openWorkspaceCommandRunner({
            workspace: runRoot,
            scratchDir: checkScratch,
            gate,
            localNetwork: true,
            ...(operation.accessPolicy ? { access: operation.accessPolicy } : {}),
            ...(extraReads.length ? { readPaths: extraReads } : {}),
            env: checkEnv,
            // Tests a check runs create their own repositories under TMPDIR (inside
            // this scratch), so the check may write Git metadata there; the workspace
            // and every other repository stay protected.
            gitMetadataWritesInsideScratch: true,
            ...limit,
          });
          try {
            return await runner.run(command.command as string, command.args as string[]);
          } finally {
            await runner.close();
          }
        };
        const result = await run();
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
            // How this run was contained, recorded with it: the same check means something different
            // outside the sandbox, and a reader of the evidence should not have to infer which one
            // produced it.
            sandboxed: !unsandboxed,
          }, null, 2)}\n`;
          const dir = join(input.scratchRoot ?? workspace, 'checks');
          mkdirSync(dir, { recursive: true });
          const path = join(dir, `${operation.nodeId}.json`);
          writeFileSync(path, body);
          const digest = createHash('sha256').update(body).digest('hex');
          if (result.code !== 0) {
            return {
              outcome: 'failed',
              output: {
                code: result.code,
                // Where the whole run lives: the same file the passing path registers as evidence. A
                // failure that reports only the tail of one channel makes its reader hunt the
                // filesystem for a record the harness had already written and already knew the path
                // of.
                record: { path, digest },
                // stdout is where a suite names the case that failed, so a summary that drops it
                // leaves the reason out. It is reported under a name the retry classifier does not
                // read on purpose: that classifier decides whether a failure looks like the
                // environment, and a test's own output full of words like "connection reset" would
                // turn a verdict on the work into three automatic reruns of it.
                stdoutTail: result.stdout.slice(-4_000),
                stderr: result.stderr.slice(-4_000),
              },
            };
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
