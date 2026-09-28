// Failure modes for automatic transient-failure retry, written before the code (R24).
//
// The user's rule: a failure that is the environment's fault retries itself, with a bound, and
// only a failure that is a verdict (or an exhausted bound) wakes the main Agent.
//
// Evidence for why: in the real state ledger, `execution_failed` was answered 105 times and every
// single answer was `retry` — about 101 of those were a network/limit/5xx blip or a PATH problem,
// not a judgement.
//
// 1. A network blip on attempt 1 retries by itself and does NOT wake main.
// 2. A real verdict (a compile/test failure) wakes main on attempt 1 — retrying it is pointless.
// 3. The bound holds: after MAX transient retries the next one wakes main.
// 4. An exhausted bound is reported as such, so main is not told "retry again" forever.
// 5. A retry is not a silent loop: each one is a recorded fact with the attempt number.
// 6. `isEnvironmentFailure` decides, and its verdict is the only thing that routes a failure.
// 7. A failure with no output at all is NOT treated as transient — unknown is not "blip".

import { expect, test } from 'vitest';
import { MAX_TRANSIENT_RETRIES, retryDecision } from '../../src/core/transient-retry.ts';

const NETWORK = '400: Connection error.';
const COMPILE = 'src/a.ts(3,5): error TS2304: Cannot find name \'foo\'.';

test('a network blip retries by itself and does not wake main', () => {
  const decision = retryDecision({ output: NETWORK, attempt: 1 });
  expect(decision).toMatchObject({ retry: true, attempt: 1 });
});

test('a real verdict wakes main immediately: retrying a compile error is pointless', () => {
  expect(retryDecision({ output: COMPILE, attempt: 1 })).toMatchObject({ retry: false });
});

test('the bound holds: the retry after the last allowed one wakes main', () => {
  for (let attempt = 1; attempt <= MAX_TRANSIENT_RETRIES; attempt += 1) {
    expect(retryDecision({ output: NETWORK, attempt })).toMatchObject({ retry: true });
  }
  const exhausted = retryDecision({ output: NETWORK, attempt: MAX_TRANSIENT_RETRIES + 1 });
  expect(exhausted).toMatchObject({ retry: false, exhausted: true });
});

test('an exhausted bound says so, so main is not invited to retry forever', () => {
  const decision = retryDecision({ output: NETWORK, attempt: MAX_TRANSIENT_RETRIES + 1 });
  expect(decision.reason).toContain('重试');
});

test('the attempt count is carried, so a retry is a recorded fact rather than a silent loop', () => {
  expect(retryDecision({ output: NETWORK, attempt: 2 })).toMatchObject({ retry: true, attempt: 2 });
});

test('a failure with no output is not treated as a blip — unknown is not transient', () => {
  expect(retryDecision({ output: '', attempt: 1 })).toMatchObject({ retry: false });
  expect(retryDecision({ output: '', attempt: 1 }).reason).toBeTruthy();
});

test('the decision names the reason it woke main, so the problem is diagnosable', () => {
  const verdict = retryDecision({ output: COMPILE, attempt: 1 });
  expect(verdict.reason).toContain('判断');
  const blip = retryDecision({ output: NETWORK, attempt: 1 });
  expect(blip.reason).toContain('自动重试');
});
