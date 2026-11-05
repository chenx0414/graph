import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The agent-desktop CLI this machine actually has.
 *
 * The capability is an external program, not a package of this repository: the
 * Graph tool is a thin wrapper around whatever `agent-desktop` the host
 * installed, so an end-to-end proof has to run that program. The candidates are
 * ordered from the most explicit to the least, and the first executable wins:
 *
 *   - `GRAPH_DESKTOP_BIN`, the way the daemon itself is pointed at a binary;
 *   - the checkout's own `node_modules`, for a project that installed it;
 *   - `/tmp/adesk/node_modules`, where this machine's delivery installed 1.1.0;
 *   - `agent-desktop` on `PATH`.
 *
 * When none of them is there the failure names the install command instead of
 * pretending the capability is absent from the product.
 */
export function desktopBinary(): string {
  const candidates: string[] = [];
  if (process.env.GRAPH_DESKTOP_BIN) candidates.push(process.env.GRAPH_DESKTOP_BIN);
  candidates.push(join(process.cwd(), 'node_modules', '.bin', 'agent-desktop'));
  candidates.push('/tmp/adesk/node_modules/.bin/agent-desktop');
  // The capability library is where the app itself installs the program, and the
  // macOS grant is bound to that path - measured 2026-11-05, when this helper
  // reported "not installed" on a machine whose desktop tool worked.
  for (const home of [process.env.GRAPH_APP_USER_DATA, join(homedir(), 'Library', 'Application Support', 'Graph')]) {
    if (home) candidates.push(join(home, 'capabilities', 'agent-desktop', 'node_modules', '.bin', 'agent-desktop'));
  }
  for (const directory of (process.env.PATH ?? '').split(':')) {
    if (directory) candidates.push(join(directory, 'agent-desktop'));
  }
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch { /* the next candidate */ }
  }
  throw new Error('agent-desktop is not installed on this machine, so the desktop capability cannot be proven '
    + '(looked for GRAPH_DESKTOP_BIN, node_modules/.bin, /tmp/adesk/node_modules/.bin and PATH). '
    + 'Install it with: npm install -g agent-desktop --allow-scripts=agent-desktop');
}

/** One finished CLI call: its stdout, its stderr and its exit code. */
export interface DesktopCall {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run the real CLI once, the way the daemon would.
 *
 * `spawnSync` rather than `execFileSync` because a refused command is the
 * interesting case here and it exits non-zero while still printing its JSON
 * envelope on stdout.
 */
export function desktopCall(args: string[], env: NodeJS.ProcessEnv = {}): DesktopCall {
  const run = spawnSync(desktopBinary(), args, {
    env: { ...process.env, ...env }, encoding: 'utf8', timeout: 60_000,
  });
  if (run.error) throw run.error;
  return { stdout: run.stdout ?? '', stderr: run.stderr ?? '', code: run.status };
}

/** The envelope the CLI prints on stdout, without the newline it ends with. */
export function desktopStdout(args: string[], env: NodeJS.ProcessEnv = {}): string {
  return desktopCall(args, env).stdout.trimEnd();
}

/** The markdown `skills get <name>` compiles into the binary, as one string. */
export function desktopSkill(name: string, env: NodeJS.ProcessEnv = {}): string {
  const envelope = JSON.parse(desktopStdout(['skills', 'get', name], env)) as {
    ok?: boolean; data?: { content?: string };
  };
  if (!envelope.ok || typeof envelope.data?.content !== 'string') {
    throw new Error(`agent-desktop skills get ${name} did not answer with markdown: ${JSON.stringify(envelope)}`);
  }
  return envelope.data.content;
}

/** Whether the CLI exists at all, for a test that must say so instead of throwing. */
export function desktopInstalled(): boolean {
  try {
    desktopBinary();
    return true;
  } catch {
    return false;
  }
}
