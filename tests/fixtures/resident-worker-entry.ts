import { runResidentWorker } from '../../src/runtime/resident-worker.ts';

const configPath = process.argv[2];
if (!configPath) throw new Error('resident worker config path is required');
await runResidentWorker(configPath);
