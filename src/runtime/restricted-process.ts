import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import type { TokenUsage } from './call-broker.ts';

export interface RestrictedGate {
  dispatch<T>(id: string, reservation: number, send: () => T): T;
  settle(id: string, usage: TokenUsage | null): void;
}

export interface RestrictedCommand {
  broker: RestrictedGate;
  cwd: string;
  scratchDir?: string;
  executable: string;
  args: string[];
  input?: string;
  readPaths: string[];
  writePaths: string[];
  denyWrite?: string[];
  timeoutMs?: number;
  onRequest?: (request: unknown) => Promise<unknown>;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function canonicalGrant(path: string) {
  const requested = resolve(path);
  if (await realpath(requested) !== requested || /[*?\[\]]/.test(requested)) {
    throw new Error('Expected an unchanged canonical grant path');
  }
  return requested;
}

function pinnedFilesystemProfile(readPaths: string[], writePaths: string[]) {
  const filters = (paths: string[]) => `(require-any ${paths.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})`;
  // Intersect SRT with literal, already-approved paths. SRT normalizes paths
  // again while building its profile; that must not turn a concurrent symlink
  // replacement into a grant to a different directory.
  return `(deny file-read* (require-not (require-any (literal "/") ${filters(readPaths)})))
    (allow file-read-metadata (vnode-type DIRECTORY))
    (deny file-write* (require-not ${filters(writePaths)}))`;
}

function extractProfile(wrapped: string, command: string) {
  // SRT 0.0.75 exposes a POSIX-quoted wrapper, not the profile itself. Decode
  // only its documented-in-source quoting dialect; never evaluate shell text.
  // Reject a changed wrapper shape when upgrading the pinned dependency.
  const words: string[] = [];
  let index = 0;
  while (index < wrapped.length) {
    if (wrapped[index] === ' ') { index++; continue; }
    let word = '';
    while (index < wrapped.length && wrapped[index] !== ' ') {
      if (wrapped[index] === "'") {
        const end = wrapped.indexOf("'", index + 1);
        if (end === -1) throw new Error('Unverified SRT wrapper quoting');
        word += wrapped.slice(index + 1, end); index = end + 1;
      } else if (wrapped.startsWith('"\'"', index)) {
        word += "'"; index += 3;
      } else if (/[A-Za-z0-9_./:=@+,-]/.test(wrapped[index]!)) {
        word += wrapped[index++];
      } else { throw new Error('Unverified SRT wrapper quoting'); }
    }
    words.push(word);
  }
  const native = words.indexOf('/usr/bin/sandbox-exec');
  const profile = words[native + 2];
  if (words[0] !== 'env' || native < 1 || words.length !== native + 6 || words[native + 1] !== '-p' ||
      !profile?.startsWith('(version 1)') || words[native + 3] !== '/bin/sh' ||
      words[native + 4] !== '-c' || words[native + 5] !== command) throw new Error('Unverified SRT wrapper shape');
  return profile;
}

/** Trusted host owns grants. Worker-supplied paths must never populate this interface. */
export async function openRestrictedExecutor() {
  if (process.platform !== 'darwin') throw new Error('Restricted execution has only been verified on macOS');
  const network = { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] };
  await SandboxManager.initialize({ network, filesystem: { denyRead: ['/'], allowWrite: [], denyWrite: [] } }, undefined, false);
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('OS sandbox unavailable');
  return {
    async run(command: RestrictedCommand): Promise<{ code: number | null; stdout: string; stderr: string }> {
      const cwd = await canonicalGrant(command.cwd);
      const readPaths = await Promise.all(command.readPaths.map(canonicalGrant));
      const writePaths = await Promise.all(command.writePaths.map(canonicalGrant));
      const scratchDir = command.scratchDir ? await canonicalGrant(command.scratchDir) : cwd;
      if (!writePaths.some(root => scratchDir === root || scratchDir.startsWith(root === '/' ? '/' : root + '/'))) {
        throw new Error('Worker scratch directory requires a write grant');
      }
      const homeDir = join(scratchDir, '.worker-home');
      const tempDir = join(scratchDir, '.worker-tmp');
      const allowedReads = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/dev', cwd, scratchDir, ...readPaths];
      const deviceWrites = ['/dev/stdout', '/dev/stderr', '/dev/null', '/dev/tty', '/dev/dtracehelper', '/dev/autofs_nowait'];
      const profile = pinnedFilesystemProfile(allowedReads, [...deviceWrites, ...writePaths]);
      const commandText = [command.executable, ...command.args].map(quote).join(' ');
      // Even setup writes happen after confinement. A mutable cwd must never
      // cause the host to create directories outside the original grant.
      const launch = `/bin/mkdir -p ${quote(homeDir)} ${quote(tempDir)} && exec ${commandText}`;
      const wrapped = await SandboxManager.wrapWithSandbox(
        launch, '/bin/sh', {
          network,
          filesystem: {
            denyRead: ['/'], allowRead: allowedReads,
            allowWrite: writePaths,
            // Remove SRT's unrelated default writable log/scratch directories.
            denyWrite: ['/tmp/claude', '/private/tmp/claude', join(homedir(), '.npm/_logs'), join(homedir(), '.claude/debug'), ...(command.denyWrite ?? [])],
          },
        },
      );
      const boundedProfile = extractProfile(wrapped, launch) + '\n' + profile;
      return new Promise((resolve, reject) => {
        const invocationId = randomUUID();
        const child = command.broker.dispatch(invocationId, 0, () => spawn('/usr/bin/sandbox-exec', ['-p', boundedProfile, '/bin/sh', '-c', launch], {
          cwd, env: { PATH: `${dirname(command.executable)}:/usr/bin:/bin`, HOME: homeDir, TMPDIR: tempDir, LANG: 'en_US.UTF-8' },
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
        }));
        let stdout = '', stderr = '';
        const timer = command.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), command.timeoutMs) : undefined;
        timer?.unref?.();
        const channel = child.stdio[3] as Duplex;
        let pending = '', requests = Promise.resolve();
        channel.on('error', () => {}); // A worker may exit after an in-flight request.
        channel.on('data', data => {
          pending += String(data);
          if (pending.length > 1_000_000) { child.kill(); return; }
          let newline: number;
          while ((newline = pending.indexOf('\n')) !== -1) {
            const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
            requests = requests.then(async () => {
              let reply;
              try {
                if (!command.onRequest) throw new Error('Worker requests not enabled');
                reply = { ok: true, value: await command.onRequest(JSON.parse(line)) };
              } catch (error) { reply = { ok: false, error: String(error) }; }
              if (!channel.destroyed) channel.write(JSON.stringify(reply) + '\n');
            });
          }
        });
        child.stdout.on('data', data => { stdout += String(data); });
        child.stderr.on('data', data => { stderr += String(data); });
        child.on('error', reject);
        child.on('close', (code, signal) => {
          if (timer) clearTimeout(timer);
          if (signal) stderr += `Process terminated by ${signal}\n`;
          command.broker.settle(invocationId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
          void requests.then(() => resolve({ code, stdout, stderr }), reject);
        });
        child.stdin.end(command.input);
      });
    },
    async close() { await SandboxManager.reset(); },
  };
}

let shared: { executor: Awaited<ReturnType<typeof openRestrictedExecutor>>; refs: number } | undefined;

/** Share one verified OS sandbox across capabilities and command tools; reset it only when idle. */
export async function acquireRestrictedExecutor() {
  if (!shared) shared = { executor: await openRestrictedExecutor(), refs: 0 };
  shared.refs += 1;
  const acquired = shared;
  return {
    executor: acquired.executor,
    async release() {
      acquired.refs -= 1;
      if (acquired.refs === 0 && shared === acquired) {
        shared = undefined;
        await acquired.executor.close();
      }
    },
  };
}
