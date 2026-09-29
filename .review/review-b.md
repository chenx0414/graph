# review-b — current impl-b output v3

Subject of this review (the version gate-b currently holds, re-read from the task store in this attempt):

- node: `impl-b`
- operation: `5488505c-32ac-433a-b5b7-d262c1e018d2`
- activation: `c15df0ee-56bb-4ade-92d4-d33139b6c191`
- output version: 3
- instance: `2a1963c9-648d-45b2-bb51-2cb48d5a9b0e`
- result outcome: `completed`
- result length: 2965
- top-level `result.artifacts`: absent (`json_type` null, `instr(result, '"artifacts"')` = 0)
- `node_write_captures` for this node: 0 rows

This report replaces the review that targeted an earlier operation. It applies only to the identity above.

## Verdict

`correctness`: pass for `scripts/diag-b.mjs`.

The gate still cannot bind a subject. `src/core/graph.ts` builds `DependencySource.artifacts` only from `OperationResult.artifacts`, and this operation does not set that field. `subject()` in `src/core/verification.ts` then rejects every report with `Review does not apply to the current artifact version` before it reads `correctness`. No subject string in this report can change that, because the source list is empty and the reviewer is given only `{ path, digest }`.

## Evidence

File under review: `scripts/diag-b.mjs`
sha256 `b34a89ae4717b15eb5b4f50b14f3eaacf2701c2fcc802e24d9510d0fc3c1eeb4`
git blob `5f6b047ea72b43ece262fd095f649166397913c9`, identical at HEAD `3e5dfbf2a3fdd999ba968ede29a5e1504b137d21` and at lane commit `31b829b37d5e2010b97a813158f77af50ccf76bd` (ancestor of HEAD).

Look-for:

- Read-only in diagnostic mode. Imports are only `node:fs`, `node:os`, `node:path`. `mkdirSync` / `writeFileSync` / `rmSync` run only inside `--self-test`, against a temp fixture, and the fixture is removed in `finally`.
- The only file the lane commits touch is `scripts/diag-b.mjs` (`8512b60` added it; `50eb7be` and `31b829b` modified only it).
- Counts are correct and repeatable. Two default runs were byte-identical (`7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`). An independent walker, not the script, recounted the same tree: 197 files, 53800 lines, 7859068 bytes, and the same module buckets (`src/web` 63/17936, `src/core` 44/13863, `src/runtime` 55/13467, `src/server` 16/4738, `src/catalog` 16/2526, `src/git` 3/1270). `--self-test` exited 0.

Repeatable artifacts of this review (this worktree):

- `.review/diag-b-run-1.txt`
- `.review/diag-b-run-2.txt`
- `.review/diag-b-self-test.txt`
- `.review/review-b.md`

## Binding gap (not a lane defect)

Published workspace artifact `b5ec21d4-d62d-4535-95c7-a5b048cd0ffd` v1 (`deliverables/shape-a-artifact-binding-defect`, digest `f9368a0c0b9cde60d69dced51619b45af2f5538945be8d8654ed0e060a46786b`) was produced by this same operation, but it is not copied into `result.artifacts`, so it is not a legal `ArtifactVersion` subject either. Naming it would still fail `sameArtifact`.

Files a harness fix would touch, none of which this lane owns: `src/runtime/pi-adapter.ts`, `src/core/execution.ts`, `src/core/graph.ts`, `src/core/verification.ts`.
