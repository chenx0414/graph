import { openPiInstance } from '../../src/runtime/pi-instance.ts';
import { modelA, respond, testModelRuntime } from './models.ts';

const [workspace, stateDir, mode] = process.argv.slice(2) as [string, string, string];
const instance = await openPiInstance({
  binding: { instanceId: 'agent-1', nodeId: 'node-1', definitionVersion: 'coder@1' },
  workspace, stateDir, model: modelA, modelRuntime: await testModelRuntime(),
  stream: mode === 'crash' ? () => {
    process.stdout.write(JSON.stringify(instance.inspect()) + '\n');
    process.exit(23);
  } : respond,
});
if (mode === 'write' || mode === 'crash') await instance.prompt('Persist across process exit');
process.stdout.write(JSON.stringify(instance.inspect()) + '\n');
await instance.close();
