// Failure modes for the RSI receipt when a call delivered nothing (HB-179), written first (R24).
//
// The miss: `apply_rsi_change({changes: [], activate: true})` returned status "applied" with
// activation "active" and the report "该提交已是运行中的版本，无需重载" — while the source checkout
// did not contain the commit at all. Three times this session the only thing that caught it was
// going to look at the files by hand. The receipt must not let a check-only call read as a delivery.
//
// 1. A call that committed nothing and whose HEAD is not the running commit must NOT say "applied"
//    or "active" — it delivered nothing, whatever it checked.
// 2. A call that did commit, with the daemon already running that commit, may say "active".
// 3. A checks-only call that passed but delivered nothing has its own honest wording.
// 4. The report must name what was actually verified versus what was delivered, so a reader can
//    tell them apart without going to the filesystem.
// 5. A committed change that needs a reload stays "pending_reload" (unchanged behaviour).

import { expect, test } from 'vitest';
import { describeActivation } from '../../src/runtime/rsi.ts';

const committed = { commit: 'new123', committedNow: true };

test('a call that committed nothing never reads as a delivery', () => {
  // The exact HB-179 shape: no commit from this call, HEAD is what already runs.
  const described = describeActivation({ commit: 'runs-now', committedNow: false, activate: true, live: true });
  expect(described.state).toBe('checked_only');
  expect(described.note).not.toContain('无需重载');
  expect(described.note).toContain('没有产生提交');
});

test('a delivered commit the daemon already runs may say active', () => {
  const described = describeActivation({ commit: 'runs-now', committedNow: true, activate: true, live: true });
  expect(described.state).toBe('active');
  expect(described.note).toContain('已在运行');
});

test('delivered work that needs a reload stays pending_reload', () => {
  const described = describeActivation({ ...committed, activate: true, live: false });
  expect(described.state).toBe('pending_reload');
});

test('a checks-only run says exactly that', () => {
  const described = describeActivation({ commit: null, committedNow: false, activate: true, live: false });
  expect(described.state).toBe('checked_only');
  expect(described.note).toContain('只跑了检查');
});

test('activation state is never claimed without a commit from this call', () => {
  for (const live of [true, false]) {
    const described = describeActivation({ commit: 'runs-now', committedNow: false, activate: true, live });
    expect(['pending_reload', 'active']).not.toContain(described.state);
  }
});
