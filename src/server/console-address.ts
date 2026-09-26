import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Where the console is listening, written for the tools that have to find it.
 *
 * The desktop app starts this daemon with `--port 0`, so the port is only known once the socket
 * is bound and nothing else records it: a browser assertion, a probe, or a person asking "which
 * port is the console on?" had no way to discover it. This file is that record.
 *
 * `pid` is here so a reader can tell a stale file left by a killed daemon from a live one. It is
 * never checked here: only the reader knows whether it runs on the same host.
 */
export interface ConsoleAddress {
  url: string;
  pid: number;
  mode: 'execute' | 'view';
  startedAt: number;
}

export function consoleAddressPath(stateDir: string): string {
  return join(stateDir, 'console.json');
}

/** Publish the bound address. Written once, when the socket is already listening. */
export async function writeConsoleAddress(stateDir: string, address: ConsoleAddress): Promise<void> {
  await writeFile(consoleAddressPath(stateDir), `${JSON.stringify(address, null, 2)}\n`, { mode: 0o600 });
}

/** The recorded address, or null when there is none or it does not read as one. */
export async function readConsoleAddress(stateDir: string): Promise<ConsoleAddress | null> {
  const raw = await readFile(consoleAddressPath(stateDir), 'utf8').catch(() => null);
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const url = value['url'];
    if (typeof url !== 'string' || !url.startsWith('http') || typeof value['pid'] !== 'number') return null;
    return {
      url,
      pid: value['pid'],
      mode: value['mode'] === 'execute' ? 'execute' : 'view',
      startedAt: typeof value['startedAt'] === 'number' ? value['startedAt'] : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Retract the record. The daemon deliberately does not call this: the record is what lets the next
 * start return to the same port, and a stopped daemon's stale url is self-evident to a reader (it
 * refuses connections, and `pid` says whose it was). Kept for a caller that wants the file gone.
 */
export async function clearConsoleAddress(stateDir: string): Promise<void> {
  await rm(consoleAddressPath(stateDir), { force: true }).catch(() => undefined);
}
