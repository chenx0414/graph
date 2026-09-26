import { createServer } from 'node:net';
import { readConsoleAddress, type ConsoleAddress } from './console-address.ts';

/**
 * The port for a request that only wants a free one.
 *
 * The desktop app starts the daemon with port 0, so every reload used to move the console to a new
 * port - which silently invalidates the tabs, windows and probes pointing at the old one. The
 * address this state directory last served on is the best guess for what should stay reachable;
 * the bind itself is still the authority, so a port taken by something else falls back to a free
 * one instead of failing.
 */
export async function preferredConsolePort(input: {
  stateDir: string;
  read?: (stateDir: string) => Promise<ConsoleAddress | null>;
  isFree?: (port: number) => Promise<boolean>;
}): Promise<number | undefined> {
  const read = input.read ?? readConsoleAddress;
  const isFree = input.isFree ?? (() => Promise.resolve(true));
  const record = await read(input.stateDir).catch(() => null);
  if (!record) return undefined;
  let port: number;
  try {
    port = Number(new URL(record.url).port);
  } catch {
    return undefined;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return undefined;
  return (await isFree(port).catch(() => false)) ? port : undefined;
}

/** Whether binding 127.0.0.1:port would succeed right now. A probe, not a reservation. */
export async function portIsFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(port, '127.0.0.1');
  });
}
