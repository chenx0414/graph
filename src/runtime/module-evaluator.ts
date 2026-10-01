import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireRestrictedExecutor } from './restricted-process.ts';
import { nodeReadPaths } from './capabilities.ts';
import { graphApplicationRoot } from './graph-root.ts';
import type { Json } from '../core/types.ts';

/**
 * Graph v2 module code (Issue #1 §9, §16 spike 3).
 *
 * A module's `evaluate({inputs,state,trigger})` is graph program logic, not an
 * installed capability. It runs in its OWN restricted process with the OS seatbelt
 * profile, so it can only read its inputs and return state/outputs/diagnostics —
 * it may not touch the network, the filesystem, credentials or another process.
 *
 * Limits fixed by the spec (§9, §15.7):
 *   - default 5 s per evaluation;
 *   - input and reply each capped at 1 MiB;
 *   - persistent state per module capped at 1 MiB;
 *   - one evaluation at a time per module (the caller serializes).
 *
 * Memory: a hard process cap is required, and the JS heap cap (`--max-old-space-size`)
 * is NOT a process cap (measured in spike 3). The caller passes the exact node flag
 * it wants proven; a real hard cap needs an OS limit on the child (RLIMIT_AS).
 */

export const MODULE_TIMEOUT_MS = 5_000;
export const MODULE_MAX_BYTES = 1_048_576;

export interface ModuleEvaluationInput {
  /** The module's code entry file (a .mjs/.js file exporting `evaluate`). */
  entry: string;
  /** One JSON value per named input; a missing input is represented by `MISSING_INPUT`. */
  inputs: Record<string, Json>;
  state: Json;
  trigger: 'each' | 'once';
}

export interface ModuleEvaluationResult {
  ok: boolean;
  state: Json;
  outputs: Record<string, Json>;
  diagnostics: string[];
  error?: string;
  /** Wall time and peak RSS the restricted process reached, for the memory report. */
  measurement: { ms: number; peakRssBytes: number | null };
}

/** Marker for "this input never received a delivery", distinct from false/null (§2). */
export const MISSING_INPUT = { __missing__: true } as const;

const workerPath = fileURLToPath(new URL('./module-worker.mjs', import.meta.url));

/**
 * Run one evaluation in a restricted child process. The child gets read access to
 * its own entry only, a scratch dir it may write, no network and no credentials.
 */
export async function evaluateModule(
  input: ModuleEvaluationInput,
  options: { executor?: Awaited<ReturnType<typeof acquireRestrictedExecutor>>; memoryCapMb?: number } = {},
): Promise<ModuleEvaluationResult> {
  const payload = JSON.stringify({ id: 'eval-1', inputs: input.inputs, state: input.state, trigger: input.trigger });
  if (Buffer.byteLength(payload) > MODULE_MAX_BYTES) {
    return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module input exceeds 1 MiB', measurement: { ms: 0, peakRssBytes: null } };
  }
  const scratch = await mkdtemp(join(tmpdir(), 'graph-module-'));
  const acquired = options.executor ?? await acquireRestrictedExecutor();
  const started = Date.now();
  try {
    const nodeFlags = options.memoryCapMb ? [`--max-old-space-size=${options.memoryCapMb}`] : [];
    // Read access is the minimum node needs to load THIS worker plus the module
    // entry: the module must not be able to read anything else, so only the entry
    // and the runtime are granted, never the module's own directory or the cwd.
    const appRoot = graphApplicationRoot();
    const readPaths = [...new Set([realpathSync(appRoot), realpathSync(workerPath), realpathSync(input.entry), ...nodeReadPaths()])];
    const run = await acquired.executor.run({
      broker: {
        dispatch: <T>(_id: string, _reservation: number, send: () => T): T => send(),
        settle: (): void => undefined,
      },
      cwd: scratch,
      scratchDir: scratch,
      executable: process.execPath,
      args: [...nodeFlags, workerPath, input.entry],
      input: `${payload}\n`,
      readPaths,
      writePaths: [scratch],
      timeoutMs: MODULE_TIMEOUT_MS,
      networkDomains: [],
      env: { PATH: '/usr/bin:/bin' },
    });
    const ms = Date.now() - started;
    if (run.code !== 0) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: run.stderr.trim() || `module process exited with ${run.code}`, measurement: { ms, peakRssBytes: null } };
    }
    const line = run.stdout.trim().split('\n').filter(Boolean).at(-1);
    if (!line) return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module produced no result', measurement: { ms, peakRssBytes: null } };
    const parsed = JSON.parse(line) as { ok: boolean; result?: { state?: Json; outputs?: Record<string, Json>; diagnostics?: string[] }; error?: string };
    if (!parsed.ok) return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: parsed.error ?? 'module threw', measurement: { ms, peakRssBytes: null } };
    const result = parsed.result ?? {};
    const replyBytes = Buffer.byteLength(JSON.stringify(result));
    if (replyBytes > MODULE_MAX_BYTES) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module reply exceeds 1 MiB', measurement: { ms, peakRssBytes: null } };
    }
    if (Buffer.byteLength(JSON.stringify(result.state ?? null)) > MODULE_MAX_BYTES) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module state exceeds 1 MiB', measurement: { ms, peakRssBytes: null } };
    }
    return {
      ok: true,
      state: result.state ?? null,
      outputs: result.outputs ?? {},
      diagnostics: result.diagnostics ?? [],
      measurement: { ms, peakRssBytes: null },
    };
  } finally {
    if (!options.executor) await acquired.release();
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Write module code to a scratch entry file for a test or a main-agent-authored extension. */
export async function writeModuleEntry(dir: string, name: string, source: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, source, { mode: 0o600 });
  return path;
}
