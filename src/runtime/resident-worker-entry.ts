import { runResidentWorker } from './resident-worker.ts';

/**
 * Production entry for a resident Pi worker process (Issue #1 §7).
 *
 * The kernel's `ResidentHost` spawns this file with a config path argument; node's
 * native TypeScript stripping loads the `.ts` worker, so no build step is needed.
 */
const configPath = process.argv[2];
if (!configPath) throw new Error('resident worker config path is required');
await runResidentWorker(configPath);
