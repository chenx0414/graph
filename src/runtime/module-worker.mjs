#!/usr/bin/env node
// Isolated host for Graph v2 module code (Issue #1 §9, §16 spike 3).
//
// A module's `evaluate({inputs,state,trigger})` is GRAPH PROGRAM LOGIC, not an
// installed capability. It runs in its own restricted process and may only read
// its inputs, return state/outputs/diagnostics — never the network, filesystem,
// credentials or another process. This host does NOT `import` module code into the
// daemon: the executor starts it with the OS seatbelt profile, so the code only
// sees the minimal face below.
//
// Contract (fixed here, §9):
//   evaluate({ inputs, state, trigger }) -> { state, outputs, diagnostics }
//   - inputs : one JSON value per named input, or {"__missing__":true} for an input
//              that never received a delivery (a missing input is NOT false/null).
//   - state  : whatever the previous evaluation returned as state.
//   - trigger: "each" | "once".
// Output must be JSON, within the reply byte cap. A throw, a timeout or a
// non-conforming return keeps the inputs and pauses the module (handled by the host).
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  process.stderr.write('graph-module-worker: missing module entry\n');
  process.exit(2);
}

let evaluate;
try {
  const loaded = await import(pathToFileURL(entry).href);
  evaluate = loaded.evaluate ?? loaded.default?.evaluate ?? loaded.default;
  if (typeof evaluate !== 'function') throw new Error('module must export evaluate({inputs,state,trigger})');
} catch (error) {
  process.stderr.write(`graph-module-worker: cannot load ${entry}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const reply = (value) => { process.stdout.write(`${JSON.stringify(value)}\n`); };

for await (const line of createInterface({ input: process.stdin })) {
  if (!line.trim()) continue;
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  const { id, inputs, state, trigger } = request ?? {};
  try {
    const result = await evaluate({ inputs, state, trigger });
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new Error('evaluate must return an object {state, outputs, diagnostics}');
    }
    reply({ id, ok: true, result });
  } catch (error) {
    reply({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
