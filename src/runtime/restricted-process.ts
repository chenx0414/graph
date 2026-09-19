import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import { readdir, realpath, writeFile } from 'node:fs/promises';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { sandboxNetworkDomains } from '../core/domains.ts';
import type { TokenUsage } from './call-broker.ts';

/**
 * The host owns the only listening sockets of a local-network check. The
 * sandbox profile denies every bind, so a check and its children cannot create
 * a listener even when they clear NODE_OPTIONS. This preload is only a routing
 * shim: loopback listen calls are served by the host's already-bound sockets,
 * and every non-loopback or unresolved call is refused before the socket API.
 */
const LOOPBACK_LISTEN_GUARD = String.raw`'use strict';
// Routing shim only: the sandbox denies every bind and the host owns the only
// loopback listeners. The host binds the exact requested port, duplicates the
// bound socket over the IPC channel and drops its own copy, so the check holds
// the only accepting descriptor. Removing this preload only removes the route;
// it can never grant a bind, and a busy port keeps its original error instead
// of being silently replaced by another one.
const net = require('node:net');
const dgram = require('node:dgram');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
function denied(message) {
  const error = new Error(message || 'EPERM: sandboxed checks may only listen on an explicit loopback host');
  error.code = 'EPERM';
  return error;
}
function deny() { throw denied(); }
function boundedPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}
function listenRequest(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path !== undefined || first.fd !== undefined) return undefined;
    const port = boundedPort(first.port === undefined ? 0 : first.port);
    return port === undefined ? undefined : { port, host: typeof first.host === 'string' ? first.host : undefined };
  }
  if (typeof first === 'string') return undefined; // Unix socket paths are not host-provided.
  const port = boundedPort(first === undefined ? 0 : first);
  return port === undefined ? undefined : { port, host: typeof args[1] === 'string' ? args[1] : undefined };
}
function lastCallback(args) {
  const last = args[args.length - 1];
  return typeof last === 'function' ? last : undefined;
}
function hostHandle(value) {
  // Node's IPC handle conversion hands the raw TCP handle of a received
  // net.Server to listen(), and check code may pass an already listening
  // host-bound server back in. Both are internal handle objects that own a
  // socket descriptor, unlike a check-supplied options object. Pass them to
  // the original implementation; the sandbox still denies bind() itself.
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof net.Server) return true;
  return typeof value.fd === 'number' && typeof value.bind === 'function' &&
    typeof value.listen === 'function' && typeof value.getsockname === 'function';
}
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
const waiting = new Map();
const fireOn = new Map();
const granted = new WeakMap();
const heldListening = new WeakMap();
let nextId = 1;
// The host owns the only loopback listener until it reports the hand-off
// complete. Both the check's callback and the native 'listening' event must
// wait for that report: code that watches the event would otherwise reach a
// port the host still accepts on. Hold the event on the instance and re-emit
// it, unchanged, once the host is gone.
function holdListening(server) {
  if (heldListening.has(server)) return;
  const original = server.emit;
  const state = { original, patched: null, deferred: null };
  state.patched = function (event, ...args) {
    if (event === 'listening') {
      state.deferred = () => original.call(this, 'listening', ...args);
      return true;
    }
    return original.apply(this, [event, ...args]);
  };
  server.emit = state.patched;
  heldListening.set(server, state);
}
function releaseListening(server, fire) {
  const state = heldListening.get(server);
  if (!state) return;
  heldListening.delete(server);
  if (server.emit === state.patched) server.emit = state.original;
  if (fire && state.deferred) state.deferred();
}
// The IPC channel must not keep a finished check alive, but a pending listen
// request needs it until its reply arrives. Ref only while one is in flight.
function channelRef() {
  if (process.channel && typeof process.channel.ref === 'function') process.channel.ref();
}
function channelIdle() {
  if (waiting.size === 0 && fireOn.size === 0 && process.channel && typeof process.channel.unref === 'function') process.channel.unref();
}
channelIdle();
net.Server.prototype.listen = function (...args) {
  if (hostHandle(args[0])) return listen.apply(this, args);
  const request = listenRequest(args);
  if (!request || request.host === undefined || !LOOPBACK.has(request.host)) deny();
  if (typeof process.send !== 'function' || process.connected === false) deny();
  const id = nextId++;
  // Node registers the listen callback as a 'listening' listener at call time,
  // so it must keep that exact position among observers registered before and
  // after the call. Register it here, not at release time.
  const callback = lastCallback(args);
  if (callback) this.once('listening', callback);
  waiting.set(id, { server: this });
  granted.set(this, id);
  channelRef();
  process.send({ type: 'graph-check-listener', id, port: request.port, host: request.host });
  return this;
};
net.Server.prototype.close = function (...args) {
  const id = granted.get(this);
  if (id !== undefined) {
    granted.delete(this);
    // Cancel a listen whose reply has not arrived yet: the late reply may
    // only release its handle, never restart this server. A cancelled server
    // must not expose a deferred 'listening' event either.
    if (waiting.delete(id) || fireOn.delete(id)) { releaseListening(this, false); channelIdle(); }
    if (typeof process.send === 'function' && process.connected !== false) {
      try { process.send({ type: 'graph-check-listener-close', id }); } catch { /* channel closed */ }
    }
  }
  return close.apply(this, args);
};
process.on('message', (message, handle) => {
  if (!message) return;
  if (message.type === 'graph-check-listener-ready') {
    const pending = fireOn.get(message.id);
    if (!pending) { channelIdle(); return; }
    fireOn.delete(message.id);
    // The host copy is fully closed: releasing the native event runs the
    // callback in its original registration position.
    releaseListening(pending.server, true);
    channelIdle();
    return;
  }
  if (message.type !== 'graph-check-listener-result') return;
  const entry = waiting.get(message.id);
  if (!entry) {
    if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
    channelIdle();
    return;
  }
  waiting.delete(message.id);
  if (message.ok && handle) {
    // Adopt first, ask the host to close its copy, and expose neither the
    // native 'listening' event nor the callback until that is done. The host
    // owns the only accepting descriptor during the hand-off, so both signals
    // must point at a port that no longer races the host.
    holdListening(entry.server);
    fireOn.set(message.id, entry);
    try { listen.call(entry.server, handle); }
    catch (error) {
      fireOn.delete(message.id);
      releaseListening(entry.server, false);
      if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
      channelIdle();
      process.nextTick(() => { throw error; });
      return;
    }
    if (typeof process.send === 'function' && process.connected !== false) {
      process.send({ type: 'graph-check-listener-adopted', id: message.id });
    } else {
      fireOn.delete(message.id);
      releaseListening(entry.server, true);
      channelIdle();
    }
    channelIdle();
    return;
  }
  const error = new Error(message.message || 'EPERM: the host refused the loopback listener');
  error.code = message.code || 'EPERM';
  channelIdle();
  process.nextTick(() => entry.server.emit('error', error));
});
// No UDP listener is host-provided; the profile denies the bind as well.
dgram.Socket.prototype.bind = function () { deny(); };
`;

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
  /** Confirmed program checks may bind and reach loopback for local app/browser tests. */
  localNetwork?: boolean;
  /** MCP-only outbound allowlist for the restricted process. */
  networkDomains?: string[];
  /** Explicit browser-MCP mode; network remains mediated by the SRT proxy. */
  allowUnrestrictedNetwork?: boolean;
  /** Allow loopback listeners/connectors for local browser daemons and Chrome CDP. */
  allowLocalBinding?: boolean;
  /** Explicit Unix socket roots for local capability daemons. */
  unixSockets?: string[];
  /** Host-selected environment for the restricted process; worker input must never populate this. */
  env?: Record<string, string>;
  /** Keep stdin open so the trusted host can steer a long-running worker. */
  keepStdinOpen?: boolean;
  /** Exposes only the process control surface the trusted host needs. */
  onSpawn?: (process: RestrictedProcessControl) => void;
  /** Trusted host callback for streamed stdout; restricted workers cannot set it. */
  onStdout?: (chunk: string) => void;
  /** Preflight without creating a ledger invocation; used before spawning an Agent process. */
  preflight?: () => void;
}

export interface RestrictedProcessControl {
  pid: number | undefined;
  write(message: unknown): boolean;
  end(): void;
  kill(signal?: NodeJS.Signals): boolean;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

async function canonicalGrant(path: string) {
  const requested = resolve(path);
  if (await realpath(requested) !== requested || /[*?\[\]]/.test(requested)) {
    throw new Error('Expected an unchanged canonical grant path');
  }
  return requested;
}

function pinnedFilesystemProfile(readPaths: string[], writePaths: string[], gitPaths: string[]) {
  const filters = (paths: string[]) => `(require-any ${paths.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})`;
  // Commands and MCP capabilities may inspect Git through the read-only
  // subcommands, but refs, the index and worktree link files stay owned by the
  // Git module. The literal filters below are built from existing directories and
  // resolved vnode paths, so a relative path cannot spell around them.
  const gitFilters = gitPaths.flatMap(path => [`(literal ${JSON.stringify(path)})`, `(subpath ${JSON.stringify(path)})`]).join(' ');
  // Intersect SRT with literal, already-approved paths. SRT normalizes paths
  // again while building its profile; that must not turn a concurrent symlink
  // replacement into a grant to a different directory.
  return `(deny file-read* (require-not (require-any (literal "/") ${filters(readPaths)})))
    (allow file-read-metadata (vnode-type DIRECTORY))
    (deny file-write* (require-not ${filters(writePaths)}))\n    ${gitFilters ? `(deny file-write* ${gitFilters})` : ''}`;
}

/** Every existing Git metadata entry under the write grants, without following symlinks. */
async function gitMetadataPaths(roots: string[], scratchDir: string) {
  const insideScratch = (path: string) => path === scratchDir || path.startsWith(`${scratchDir}/`);
  const found = new Set<string>();
  let entriesSeen = 0;
  for (const root of roots) {
    if (roots.some(other => other !== root && (root === other || root.startsWith(`${other}/`)))) continue; // A parent grant covers this root.
    const stack = [root];
    while (stack.length) {
      const dir = stack.pop()!;
      if (insideScratch(dir)) continue;
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); }
      catch { continue; } // File roots, device nodes and vanished directories have nothing to scan.
      entriesSeen += entries.length;
      if (entriesSeen > 50_000) throw new Error('Workspace is too large to verify the Git metadata boundary');
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.name === '.git') { found.add(path); continue; }
        if (!entry.isDirectory() || entry.name === 'node_modules') continue;
        stack.push(path);
      }
    }
  }
  return [...found];
}

function extractWrapper(wrapped: string, command: string) {
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
  const environment: Record<string, string> = {};
  for (const assignment of words.slice(1, native)) {
    const separator = assignment.indexOf('=');
    const name = separator > 0 ? assignment.slice(0, separator) : '';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error('Unverified SRT wrapper environment');
    environment[name] = assignment.slice(separator + 1);
  }
  return { profile, environment };
}

/** Trusted host owns grants. Worker-supplied paths must never populate this interface. */
export async function openRestrictedExecutor() {
  if (process.platform !== 'darwin') throw new Error('Restricted execution has only been verified on macOS');
  const noNetwork = { allowedDomains: [], deniedDomains: [], allowLocalBinding: false, allowUnixSockets: [] };
  const baseFilesystem = { denyRead: ['/'], allowWrite: [], denyWrite: [] };
  await SandboxManager.initialize({ network: noNetwork, filesystem: baseFilesystem }, async () => false, false);
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('OS sandbox unavailable');
  let networkTail: Promise<void> = Promise.resolve();
  async function acquireNetworkConfig(
    domains: string[],
    unixSockets: string[] = [],
  ): Promise<() => void> {
    if (!domains.length && !unixSockets.length) return () => {};
    const previous = networkTail;
    let release!: () => void;
    networkTail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    // SRT's per-run config changes the sandbox profile, but its live proxy
    // reads the manager config. Serialize different allowlists so a process
    // can never inherit another capability's network grant.
    SandboxManager.updateConfig({
      network: {
        allowedDomains: sandboxNetworkDomains(domains),
        deniedDomains: [],
        allowLocalBinding: false,
        allowUnixSockets: unixSockets,
      },
      filesystem: baseFilesystem,
    });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      SandboxManager.updateConfig({ network: noNetwork, filesystem: baseFilesystem });
      release();
    };
  }
  return {
    async run(command: RestrictedCommand): Promise<{ code: number | null; stdout: string; stderr: string }> {
      const cwd = await canonicalGrant(command.cwd);
      const readPaths = await Promise.all(command.readPaths.map(canonicalGrant));
      const writePaths = await Promise.all(command.writePaths.map(canonicalGrant));
      const unixSockets = await Promise.all((command.unixSockets ?? []).map(canonicalGrant));
      const allowLocalBinding = Boolean(command.localNetwork || command.allowLocalBinding);
      const network = command.localNetwork
        ? { allowedDomains: [], deniedDomains: [], allowLocalBinding: true, allowUnixSockets: unixSockets }
        : {
            allowedDomains: sandboxNetworkDomains(command.networkDomains),
            deniedDomains: [],
            allowLocalBinding,
            allowUnixSockets: unixSockets,
          };
      const scratchDir = command.scratchDir ? await canonicalGrant(command.scratchDir) : cwd;
      if (!writePaths.some(root => scratchDir === root || scratchDir.startsWith(root === '/' ? '/' : root + '/'))) {
        throw new Error('Worker scratch directory requires a write grant');
      }
      const homeDir = join(scratchDir, '.worker-home');
      const tempDir = join(scratchDir, '.worker-tmp');
      // The macOS Git shim resolves its developer directory through
      // /private/var/select and then executes the Command Line Tools binaries.
      const systemReads = ['/System', '/usr', '/bin', '/sbin', '/Library/Apple', '/dev'];
      for (const shim of ['/private/var/select', '/Library/Developer/CommandLineTools']) if (existsSync(shim)) systemReads.push(shim);
      // Checks may resolve loopback host names (for example vitest resolves
      // localhost). The resolver reads /etc/hosts and friends, and the
      // profile's subpath filters only match directories.
      if (existsSync('/etc')) systemReads.push(realpathSync('/etc'));
      const allowedReads = [...systemReads, cwd, scratchDir, ...readPaths, ...unixSockets];
      const deviceWrites = ['/dev/stdout', '/dev/stderr', '/dev/null', '/dev/tty', '/dev/dtracehelper', '/dev/autofs_nowait'];
      const gitPaths = await gitMetadataPaths(writePaths, scratchDir);
      const profile = pinnedFilesystemProfile(allowedReads, [...deviceWrites, ...writePaths], gitPaths);
      // SRT's dynamic proxy enforces one process-global allowlist. An
      // unrestricted Pi extension can live for the whole Agent turn, so it
      // cannot hold that lock without deadlocking host-side MCP calls from the
      // same turn. Give only that process a static direct-network profile
      // instead; allowlisted executions still use the serialized SRT proxy.
      const networkProfile: string[] = [];
      if (command.allowUnrestrictedNetwork) {
        networkProfile.push('(allow network-outbound)');
      }
      if (command.localNetwork) {
        networkProfile.push(
          '(allow network-inbound (local ip "localhost:*"))',
          '(allow network-outbound (remote ip "localhost:*"))',
          '(deny network-bind)',
        );
      } else if (command.allowLocalBinding) {
        networkProfile.push(
          '(allow network-bind (local ip "*:*"))',
          '(allow network-inbound (local ip "*:*"))',
          '(allow network-outbound (remote ip "localhost:*"))',
        );
      }
      if (command.localNetwork || command.allowLocalBinding) {
        networkProfile.push(
          '(allow mach-register (global-name-regex #"^org\\.chromium\\."))',
          '(allow mach-lookup (global-name-regex #"^org\\.chromium\\."))',
          '(allow mach-register (global-name-regex #"^com\\.google\\.chrome(?:\\.|$)"))',
          '(allow mach-lookup (global-name-regex #"^com\\.google\\.chrome(?:\\.|$)"))',
          // macOS name resolution goes through mDNSResponder rather than a
          // plain DNS socket, so direct-network browser processes need this
          // additional lookup even when network-outbound is unrestricted.
          '(allow mach-lookup (global-name "com.apple.mDNSResponder"))',
          '(allow mach-lookup (global-name "com.apple.SystemConfiguration.DNSConfiguration"))',
          '(allow system-socket (socket-domain AF_UNIX))',
          '(allow network-outbound (remote unix-socket (literal "/private/var/run/mDNSResponder")))',
          '(allow file-read* (literal "/Library/Preferences/com.apple.networkd.plist"))',
          '(allow file-read-metadata (literal "/var"))',
          '(allow file-read-metadata (literal "/etc"))',
          // Chrome reads kern.hv_vmm_present during startup on macOS. The
          // sandbox runtime otherwise denies that read and Chrome aborts.
          '(allow sysctl-read (sysctl-name "kern.hv_vmm_present"))',
        );
      }
      if (unixSockets.length) {
        networkProfile.push('(allow system-socket (socket-domain AF_UNIX))');
        for (const path of unixSockets) {
          networkProfile.push(
            `(allow network-bind (local unix-socket (subpath ${JSON.stringify(path)})))`,
            `(allow network-outbound (remote unix-socket (subpath ${JSON.stringify(path)})))`,
          );
        }
      }
      const localNetworkProfile = networkProfile.length ? `\n${networkProfile.join('\n')}` : '';
      const commandText = [command.executable, ...command.args].map(quote).join(' ');
      // Even setup writes happen after confinement. A mutable cwd must never
      // cause the host to create directories outside the original grant.
      const launch = `/bin/mkdir -p ${quote(homeDir)} ${quote(tempDir)} && exec ${commandText}`;
      const releaseNetwork = command.allowUnrestrictedNetwork
        ? async () => undefined
        : await acquireNetworkConfig(command.localNetwork ? [] : command.networkDomains ?? [], unixSockets);
      try {
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
        const extracted = extractWrapper(wrapped, launch);
        const boundedProfile = extracted.profile + '\n' + profile + localNetworkProfile;
        if (process.env.GRAPH_SANDBOX_PROFILE_DUMP) writeFileSync(process.env.GRAPH_SANDBOX_PROFILE_DUMP, boundedProfile);
        let listenGuard: string | undefined;
        // An IPC channel carries each host-bound loopback listener to the check.
        const stdio: ('pipe' | 'ipc')[] = command.localNetwork ? ['pipe', 'pipe', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe', 'pipe'];
        if (command.localNetwork) {
          listenGuard = join(scratchDir, '.graph-listen-guard.cjs');
          await writeFile(listenGuard, LOOPBACK_LISTEN_GUARD, { mode: 0o600 });
        }
        // --test-isolation=none keeps node --test files in the process that owns
        // the IPC channel; an isolation child would have no route to the host.
        const guardEnv = listenGuard
          ? { NODE_OPTIONS: [command.env?.NODE_OPTIONS, '--test-isolation=none', `--require=${listenGuard}`].filter(Boolean).join(' ') }
          : {};
        // Host listeners stay open until their handle is actually written to the
        // channel: Node queues handle sends behind an unacknowledged one and
        // reads the server handle only when that queue is flushed.
        const pendingListeners = new Map<number, TcpServer>();
        const boundListeners = new Set<number>();
        const cancelledListeners = new Set<number>();
        // The check supplies the request ids and may send raw messages, so ids
        // must be treated as untrusted: a repeated id would otherwise overwrite a
        // live listener and escape the run-end cleanup.
        const seenListeners = new Set<number>();
        const closePendingListeners = () => {
          for (const listener of pendingListeners.values()) { try { listener.close(); } catch { /* already closed */ } }
          pendingListeners.clear();
          boundListeners.clear();
          cancelledListeners.clear();
          seenListeners.clear();
        };
        return await new Promise((resolve, reject) => {
          const invocationId = randomUUID();
          const spawnProcess = () => {
          const proxyEnvironment = command.allowUnrestrictedNetwork
            // The static direct-network profile must not inherit the dynamic
            // proxy that belongs to another execution's allowlist.
            ? {
                ...Object.fromEntries(Object.entries(extracted.environment).filter(([name]) =>
                  !/^(?:http|https|all|grpc|ftp)_proxy$/i.test(name)
                  && name !== 'NODE_USE_ENV_PROXY'
                  && name !== 'TMPDIR' && name !== 'TMP' && name !== 'TEMP')),
                NO_PROXY: '*', no_proxy: '*',
              }
            : command.networkDomains?.length
              // The SRT wrapper normally applies these variables through `env`.
              // Keep it to the proxy port and force allowlisted traffic through
              // that port instead of direct private-network attempts.
              ? {
                  ...Object.fromEntries(Object.entries(extracted.environment)
                    .filter(([name]) => name !== 'TMPDIR' && name !== 'TMP' && name !== 'TEMP')
                    .map(([name, value]) => [name, value.replaceAll('localhost', '127.0.0.1')])),
                  NO_PROXY: '', no_proxy: '', NODE_USE_ENV_PROXY: '1',
                }
              : {};
            const spawned = spawn('/usr/bin/sandbox-exec', ['-p', boundedProfile, '/bin/sh', '-c', launch], {
              cwd, detached: true, env: { PATH: `${dirname(command.executable)}:/usr/bin:/bin`, HOME: homeDir, TMPDIR: tempDir, LANG: 'en_US.UTF-8', GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_ATTR_NOSYSTEM: '1', ...(command.env ?? {}), ...proxyEnvironment, ...guardEnv },
              stdio,
            });
            command.onSpawn?.({
              pid: spawned.pid,
              write(message) {
                if (!spawned.stdin || spawned.stdin.destroyed) return false;
                try { return spawned.stdin.write(`${JSON.stringify(message)}\n`); }
                catch { return false; }
              },
              end() {
                if (!spawned.stdin || spawned.stdin.destroyed) return;
                try { spawned.stdin.end(); }
                catch { /* already closed */ }
              },
              kill(signal = 'SIGTERM') {
                try { return spawned.kill(signal); }
                catch { return false; }
              },
            });
            if (command.localNetwork) {
              // The host owns every listener: it binds the exact loopback port a
              // check asks for, duplicates the bound socket over the IPC channel
              // and then drops its own descriptor. The check holds the only
              // accepting copy, a busy port keeps its original error instead of
              // being replaced, and no descriptor survives a denied dispatch, a
              // failed spawn or an executor close.
              spawned.on('message', (raw: unknown) => {
                if (!raw || typeof raw !== 'object') return;
                const request = raw as { type?: unknown; id?: unknown; port?: unknown; host?: unknown };
                const requestId = Number.isInteger(request.id) ? request.id as number : undefined;
                const reply = (payload: Record<string, unknown>) => {
                  try { spawned.send(payload); } catch { /* The channel is gone; the check guard denies its listen. */ }
                };
                if (request.type === 'graph-check-listener-close') {
                  if (requestId !== undefined) {
                    const held = pendingListeners.get(requestId);
                    if (held !== undefined && boundListeners.delete(requestId)) {
                      // The check closed its server before or after adoption.
                      pendingListeners.delete(requestId);
                      held.close();
                    } else {
                      cancelledListeners.add(requestId);
                    }
                  }
                  return;
                }
                if (request.type === 'graph-check-listener-adopted') {
                  if (requestId === undefined) return;
                  const held = pendingListeners.get(requestId);
                  if (held === undefined) { reply({ type: 'graph-check-listener-ready', id: requestId }); return; }
                  pendingListeners.delete(requestId);
                  boundListeners.delete(requestId);
                  // Close the host copy completely, then release the check's
                  // listen callback. The adopted descriptor stays valid.
                  held.close(() => reply({ type: 'graph-check-listener-ready', id: requestId }));
                  return;
                }
                if (request.type !== 'graph-check-listener') return;
                const port = Number.isInteger(request.port) && (request.port as number) >= 0 && (request.port as number) <= 65_535 ? request.port as number : undefined;
                const host = request.host === '127.0.0.1' || request.host === '::1' || request.host === 'localhost' ? request.host : undefined;
                if (requestId === undefined || port === undefined || host === undefined) {
                  if (requestId !== undefined) reply({ type: 'graph-check-listener-result', id: requestId, ok: false, code: 'EINVAL', message: 'Invalid listener request' });
                  return;
                }
                if (seenListeners.has(requestId) || seenListeners.size >= 1_024) {
                  reply({ type: 'graph-check-listener-result', id: requestId, ok: false, code: 'EINVAL', message: 'Duplicate listener id' });
                  return;
                }
                seenListeners.add(requestId);
                const listener: TcpServer = createTcpServer();
                pendingListeners.set(requestId, listener);
                listener.once('error', (error: NodeJS.ErrnoException) => {
                  pendingListeners.delete(requestId);
                  boundListeners.delete(requestId);
                  cancelledListeners.delete(requestId);
                  reply({ type: 'graph-check-listener-result', id: requestId, ok: false, code: error.code ?? 'EPERM', message: String(error) });
                  listener.close();
                });
                listener.listen(port, host, () => {
                  if (cancelledListeners.delete(requestId)) { pendingListeners.delete(requestId); boundListeners.delete(requestId); listener.close(); return; }
                  boundListeners.add(requestId);
                  const address = listener.address();
                  const payload = { type: 'graph-check-listener-result', id: requestId, ok: true, port: typeof address === 'object' && address ? address.port : port };
                  try {
                    spawned.send(payload, listener, error => {
                      // The listener stays open until the check reports adoption:
                      // a send queued behind another handle reads server._handle
                      // only when that queue is flushed. Failures release it now.
                      if (error) {
                        pendingListeners.delete(requestId);
                        boundListeners.delete(requestId);
                        listener.close();
                        reply({ type: 'graph-check-listener-result', id: requestId, ok: false, code: 'EIO', message: String(error) });
                        return;
                      }
                      if (cancelledListeners.delete(requestId)) {
                        pendingListeners.delete(requestId);
                        boundListeners.delete(requestId);
                        listener.close();
                      }
                    });
                  } catch (error) {
                    pendingListeners.delete(requestId);
                    boundListeners.delete(requestId);
                    listener.close();
                    reply({ type: 'graph-check-listener-result', id: requestId, ok: false, code: 'EIO', message: String(error) });
                  }
                });
              });
            }
            return spawned;
          };
          command.preflight?.();
          const child = command.preflight ? spawnProcess() : command.broker.dispatch(invocationId, 0, spawnProcess);
          let stdout = '', stderr = '';
          // The sandbox child is a process-group leader: timeouts and completion
          // must reap its whole tree so a hung check cannot leak grandchildren.
          const killTree = () => { closePendingListeners(); try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } } };
          const timer = command.timeoutMs ? setTimeout(killTree, command.timeoutMs) : undefined;
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
          child.stdout!.on('data', data => {
            const chunk = String(data);
            stdout += chunk;
            command.onStdout?.(chunk);
          });
          child.stderr!.on('data', data => { stderr += String(data); });
          child.on('error', error => { closePendingListeners(); reject(error); });
          child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            killTree();
            if (signal) stderr += `Process terminated by ${signal}\n`;
            if (!command.preflight) command.broker.settle(invocationId, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
            void requests.then(() => resolve({ code, stdout, stderr }), reject);
          });
          if (command.keepStdinOpen) {
            if (command.input) child.stdin!.write(command.input);
          } else {
            child.stdin!.end(command.input);
          }
        });
      } finally {
        releaseNetwork();
      }
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
