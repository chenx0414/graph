import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CallBroker } from '../../src/runtime/call-broker.ts';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

test('pause closes the dispatch gate while an in-flight call can settle once across restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graph-budget-')); dirs.push(dir);
  const path = join(dir, 'calls.sqlite');
  let broker = new CallBroker(path, 'agent-1', 100);
  const sent: string[] = [];
  broker.dispatch('call-1', 80, () => { sent.push('call-1'); });
  broker.pause();
  expect(broker.inspect().status).toBe('pausing');
  expect(() => broker.dispatch('call-2', 10, () => { sent.push('call-2'); })).toThrow('paused');
  // Raw provider totals include cached input and reasoning output already.
  broker.settle('call-1', { input: 20, output: 10, cacheRead: 30, cacheWrite: 5 });
  broker.settle('call-1', { input: 20, output: 10, cacheRead: 30, cacheWrite: 5 });
  expect(broker.inspect()).toMatchObject({ status: 'paused', used: 65, reserved: 0 });
  broker.close();
  broker = new CallBroker(path, 'agent-1', 100);
  try {
    expect(broker.inspect().used).toBe(65);
    broker.resume();
    expect(() => broker.dispatch('too-large', 40, () => {})).toThrow('budget');
    expect(sent).toEqual(['call-1']);
  } finally { broker.close(); }
});

test('an interrupted invocation retains its reservation and blocks automatic recovery retries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graph-unknown-')); dirs.push(dir);
  const path = join(dir, 'calls.sqlite');
  let broker = new CallBroker(path, 'agent-1', 100);
  broker.dispatch('finished', 20, () => {});
  broker.settle('finished', { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 });
  broker.dispatch('interrupted', 70, () => {});
  broker.close();
  broker = new CallBroker(path, 'agent-1', 100);
  try {
    expect(broker.inspect()).toMatchObject({ used: 15, reserved: 70, status: 'blocked' });
    broker.resume();
    expect(() => broker.dispatch('retry', 10, () => {})).toThrow('unknown usage');
    expect(() => broker.settle('finished', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })).toThrow('Conflicting');
  } finally { broker.close(); }
});
