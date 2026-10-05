import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runModuleContainer, MODULE_MEMORY_MB } from './module-container.ts';
import type { ModuleDefinition } from '../core/interface-spec.ts';
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
 * Memory is bounded by a Linux cgroup in the pinned Docker runtime, including native
 * and Buffer allocations. Missing Docker/image is reported as a module failure;
 * arbitrary code never falls back to execution in the host or a heap-only limit.
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
  limits?: ModuleDefinition['limits'];
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
  options: { memoryCapMb?: number } = {},
): Promise<ModuleEvaluationResult> {
  const limits = { timeoutMs: MODULE_TIMEOUT_MS, memoryMb: MODULE_MEMORY_MB, inputBytes: MODULE_MAX_BYTES, outputBytes: MODULE_MAX_BYTES, stateBytes: MODULE_MAX_BYTES, ...input.limits };
  const payload = JSON.stringify({ id: 'eval-1', inputs: input.inputs, state: input.state, trigger: input.trigger });
  if (Buffer.byteLength(payload) > limits.inputBytes) {
    return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: `module input exceeds ${limits.inputBytes} bytes`, measurement: { ms: 0, peakRssBytes: null } };
  }
  if (Buffer.byteLength(JSON.stringify(input.state)) > limits.stateBytes) return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: `module state exceeds ${limits.stateBytes} bytes`, measurement: { ms: 0, peakRssBytes: null } };
  const scratch = await mkdtemp(join(tmpdir(), 'graph-module-'));
  const started = Date.now();
  try {
    await writeFile(join(scratch, 'worker.mjs'), await readFile(workerPath), { mode: 0o444 });
    await writeFile(join(scratch, 'module.mjs'), await readFile(input.entry), { mode: 0o444 });
    const run = await runModuleContainer({ directory: scratch, payload: `${payload}\n`, memoryMb: options.memoryCapMb ?? limits.memoryMb,
      timeoutMs: limits.timeoutMs, maxOutputBytes: limits.outputBytes });
    const ms = Date.now() - started;
    if (run.code !== 0) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: run.stderr.trim() || `module process exited with ${run.code}`, measurement: { ms, peakRssBytes: null } };
    }
    const line = run.stdout.trim().split('\n').filter(Boolean).at(-1);
    if (!line) return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module produced no result', measurement: { ms, peakRssBytes: null } };
    let parsed: { ok: boolean; result?: { state?: Json; outputs?: Record<string, Json>; diagnostics?: string[] }; error?: string };
    try { parsed = JSON.parse(line) as { ok: boolean; result?: { state?: Json; outputs?: Record<string, Json>; diagnostics?: string[] }; error?: string }; }
    catch { return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module produced invalid JSON', measurement: { ms, peakRssBytes: null } }; }
    if (!parsed.ok) return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: parsed.error ?? 'module threw', measurement: { ms, peakRssBytes: null } };
    const result = parsed.result ?? {};
    if (!result.outputs || typeof result.outputs !== 'object' || Array.isArray(result.outputs) || !Array.isArray(result.diagnostics) || result.diagnostics.some(item => typeof item !== 'string')) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: 'module must return {state,outputs:object,diagnostics:string[]}', measurement: { ms, peakRssBytes: null } };
    }
    const replyBytes = Buffer.byteLength(JSON.stringify(result));
    if (replyBytes > limits.outputBytes) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: `module reply exceeds ${limits.outputBytes} bytes`, measurement: { ms, peakRssBytes: null } };
    }
    if (Buffer.byteLength(JSON.stringify(result.state ?? null)) > limits.stateBytes) {
      return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: `module state exceeds ${limits.stateBytes} bytes`, measurement: { ms, peakRssBytes: null } };
    }
    return {
      ok: true,
      state: result.state ?? null,
      outputs: result.outputs ?? {},
      diagnostics: result.diagnostics ?? [],
      measurement: { ms, peakRssBytes: null },
    };
  } catch (error) {
    return { ok: false, state: input.state, outputs: {}, diagnostics: [], error: error instanceof Error ? error.message : String(error), measurement: { ms: Date.now() - started, peakRssBytes: null } };
  } finally {
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
