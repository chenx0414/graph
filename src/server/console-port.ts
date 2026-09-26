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
  waitMs?: number;
  pollMs?: number;
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
  // The daemon being replaced is usually still closing its socket, so the remembered port is
  // expected to be busy for a moment. Waiting for it is what makes a reload keep the address:
  // measured, a bare probe moved the console to a new port on every reload, and the only way to
  // tell "still exiting" apart from "someone else's service" is to watch the port for a while.
  const deadline = Date.now() + (input.waitMs ?? 0);
  const pollMs = Math.max(10, input.pollMs ?? 150);
  for (;;) {
    if (await isFree(port).catch(() => false)) return port;
    if (Date.now() >= deadline) return undefined;
    await new Promise(done => setTimeout(done, pollMs));
  }
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
