interface DaemonProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}

/** Stop this process only: a replacement may start before the grace period ends. */
export function stopDaemonProcess(process: DaemonProcess | null): Promise<void> {
  if (!process || process.exitCode !== null || process.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      process.removeListener('exit', done);
      resolve();
    };
    const timer = setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL');
    }, 5_000);
    process.once('exit', done);
    process.kill('SIGTERM');
  });
}
