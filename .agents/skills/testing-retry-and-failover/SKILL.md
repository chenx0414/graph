---
name: testing-retry-and-failover
created-by: graph-agent
description: Use when writing tests for, or debugging, retry/failover/candidate-selection paths (ordered fallback across models or endpoints, fault injection via error responses).
---

# Testing and debugging retry / failover paths

Use when a code path makes an ordered sequence of attempts (fallback models, endpoints,
candidate lists) and either the tests or the real behaviour disagree with expectations.

## Debugging: bisect before instrumenting

1. Read what the evidence actually records. If the run only logged **one** attempt where
   you expected several, do not assume the loop exited early — the loop and the logger are
   different suspects.
2. Before adding logs, tracing, or retries, reproduce the behaviour with a **minimal unit
   test against the pure function** that does the selection/decision. This is the cheapest
   way to cut the problem in half: the pure function either picks the wrong candidates or it
   does not, and the answer tells you which half to instrument.
3. Only after the pure function passes do you touch the wiring (transport, retries, async
   ordering). Instrumenting first means you debug two unknowns at once.
4. When the pure function is the culprit, check the *inputs* it is allowed to choose from.
   A selector that can pick the caller itself will silently "work" while logging nothing
   useful — for reviewer/critic loops, exclude the primary actor from the candidate set
   explicitly rather than relying on ordering.

## Test fixtures: do not inject faults via error status codes with exact-count assertions

- Returning an error status to make an attempt "fail" hands control to the transport layer,
  which may retry on your behalf and consume the scripted response. Asserting an exact
  attempt count then fails for reasons unrelated to your logic.
- Assert on **what the code decided** (chosen candidate, fallback order, final answer
  identity) and on **recorded per-attempt fields** (attempt model, stop reason, error text,
  payload size). Reserve ordering/count assertions for tests that control the transport.
- Make the path observable: emit one event per attempt plus the final answer's identity, so
  a failing test tells you *which* attempt diverged instead of only that the count was off.
- Give the failure path an early return for the unconfigured/empty case so the happy path
  is not the only tested branch.

## Verify against the real artifact

A fix is not verified by a green integration test alone when the code ships into a built
artifact: confirm the shipped source contains the fix (diff or byte check the packaged
copy), and re-run the gate plus the build/verify commands after reloading.
