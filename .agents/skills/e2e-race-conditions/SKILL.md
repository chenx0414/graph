---
name: e2e-race-conditions
created-by: graph-agent
description: Use when a browser/E2E assertion fails only under parallel or full-suite load, or when writing assertions that depend on UI updates after an action.
---

# E2E browser race conditions

## Symptom to recognize

An assertion passes when its test file runs alone, and passes locally, but fails
only in the full parallel suite (or under load). That is a race, not a bad
assertion and not a broken feature. Do not treat "it passed when I ran it
alone" as evidence the code is fine.

## Procedure

1. Confirm the shape of the failure: run the single test in isolation (passes),
   then run the same test inside the full parallel suite (fails). The
   difference between those two runs *is* the bug.
2. Identify what the assertion reads. If it reads state that the browser is
   still converging on — rendered text, an element that is inserted
   asynchronously, an enabled/disabled flag — the assertion is racing the
   update.
3. Replace the immediate read with a wait on the condition itself. Wait for the
   specific text or element the test needs, then assert on it. The wait must be
   on the observable outcome, not on a fixed sleep: a `sleep(500)` moves the
   race instead of removing it and will resurface on a slower machine.
4. Keep the assertion that follows the wait strict. The fix is the wait, not
   loosening what is checked.
5. Re-run the full parallel suite, not just the one test. A race fix that is
   only verified in isolation is unverified.

## Pitfalls

- Loosening the assertion (accepting partial text, dropping the check) hides a
  real regression the next time it appears. Wait, then assert exactly.
- Fixed delays are load-dependent; they trade a frequent failure for a rarer
  one.
- A test that only ever fails under parallelism usually shares a fixture,
  server, or port with other tests — check for that before assuming the race is
  inside the page.
- Do not re-run a flaky test until it passes and call it done. Record what
  changed, or the next run reintroduces it.

## Verifying before shipping

Build and the repo's check command each passing individually does not mean the
change is safe under load. Any fix to a timing-sensitive path must be validated
by the same parallel/full-load invocation that exposed it.
