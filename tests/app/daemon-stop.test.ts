import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { stopDaemonProcess } from '../../desktop/daemon-process.ts';

class Daemon extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill = vi.fn((_signal: NodeJS.Signals) => true);
  exit(code: number | null, signal: NodeJS.Signals | null = null) {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit('exit', code, signal);
  }
}
afterEach(() => vi.useRealTimers());

test('a completed stop cannot kill the replacement after the old grace period', async () => {
  vi.useFakeTimers();
  let child = new Daemon();
  const old = child;
  const stopped = stopDaemonProcess(child);
  expect(old.kill).toHaveBeenCalledWith('SIGTERM');
  old.exit(0);
  await stopped;
  child = new Daemon();
  await vi.advanceTimersByTimeAsync(6_000);
  expect(child.kill).not.toHaveBeenCalled();
  expect(old.kill).toHaveBeenCalledTimes(1);
  expect(old.listenerCount('exit')).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('only a still-running stopped process receives the forced kill', async () => {
  vi.useFakeTimers();
  const child = new Daemon();
  const stopped = stopDaemonProcess(child);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
  child.exit(null, 'SIGKILL');
  await stopped;
  await stopDaemonProcess(child);
  expect(child.kill).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});

test('an immediate signal exit clears the timer and is already stopped', async () => {
  vi.useFakeTimers();
  const child = new Daemon();
  child.kill.mockImplementation(() => { child.exit(null, 'SIGTERM'); return true; });
  await stopDaemonProcess(child);
  await stopDaemonProcess(child);
  expect(child.kill).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
