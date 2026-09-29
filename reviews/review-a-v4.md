# review-a attempt 4 — current impl-a output v3

Reviewed only the current impl-a source. Not a previous review, and not a previous operation.

## Frozen source (read from tasks.sqlite at review time)

- `nodes.impl-a`: status `succeeded`, activation `e6466637-10c1-4ab1-b6d1-4f9fe8eeb858`, `output_version` 3, `output_operation` `5f014d53-0461-415d-8fde-9c514fa32c66`, `stall_count` 3.
- That operation is the latest succeeded `impl-a` row. Its `result` keys are `outcome`, `output`, `usage`. `json_extract(result,'$.artifacts')` is NULL, so `DependencySource.artifacts` built by `src/core/graph.ts` is `[]`.
- Node output publishes `summaries/impl-a-gate-a-root-cause@2` and `summaries/impl-a-diag-a-evidence@1`. Those URIs are inside `output`, not top-level `result.artifacts`.
- `gate-a` verifier: multiview, `subjectNode` `impl-a`, required dimension `correctness`, `reportNode` `review-a`.
- Bytes reviewed: `scripts/diag-a.mjs`, blob `b8dfa257d35af32612c1298bb6c93e12ba5ea8f2`, introduced by `d437df46ab6c108e36625c4c13f28f86d13067eb`, sha256 `3903d76f458c4fa218f8799357d10d51e58cd264cb67583f802918bf0fb6f1ed`, 6209 bytes. Worktree HEAD is `685044291c455d5f6f7f6ece8f6316957518a88b`; the file is clean and unchanged by operation `5f014d53`.

## Why the previous review was stale to the gate

`reviews/review-a@2` was markdown prose. `evaluateVerifier` reads `operation.dependencies['review-a']`, which is this node's `submit_result` payload (`src/runtime/pi-adapter.ts` returns `submitted` as `output`). A prose artifact is not that payload, so the gate never received `schemaVersion: 1` plus a subject equal to an entry of the current source. This submission is that payload.

## correctness

`node scripts/diag-a.mjs` exits 0 and prints:

```text
[diag-a] 测试文件 216 个，用例 1422 项（tests/**/*.test.ts；每个 test/it 声明计 1 项，test.each 按声明计 1）
```

The script imports only `node:fs`, `node:path`, and `node:url`, and its header contract is read-only. The predecessor records typecheck and lint as exit 0; this review did not rerun those two checks.

Verdict on the lane file: pass.

## Binding limit

`src/core/verification.ts` `subject()` accepts a report subject only when it equals one entry of `dependencySources['impl-a'][0].artifacts` on id, path, digest, nodeId, operationId, and activationId. That list is empty for the current operation. No id this review can name is a current artifact version. The subject below is therefore the only version the handoff supplies: the current operation and activation, with an explicit empty artifact identity. If the gate still rejects it, the rejection is the empty source list, not a review of an older output.
