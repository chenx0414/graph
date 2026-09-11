import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
const stateDir = process.argv[2]!;
try {
  const runtime = await openTaskRuntime({ stateDir });
  process.send?.({ type: 'ready' });
  process.on('message', async message => {
    if (message === 'close') { await runtime.close(); process.exit(0); }
  });
} catch (error) {
  process.send?.({ type: 'error', code: (error as { code?: string }).code });
  process.exit(2);
}
