# review-a v5 — subject: impl-a output v4 (operation `e73037e4`)

Verdict for the gate dimension `correctness`: **pass** on the lane deliverable `scripts/diag-a.mjs`.

Raw evidence (commands, outputs, digests): `reviews/review-a-v5-evidence.txt`.

## Frozen source reviewed

| item | value |
|---|---|
| `impl-a` node | `succeeded`, `output_version` 4, `output_operation` `e73037e4-0715-44a3-9125-4c6442f9770f`, `activation_id` `ce92e57e-9b09-4502-adad-9bf4cd2ef3ce` |
| reviewed file | `scripts/diag-a.mjs`, 6209 bytes, sha256 `3903d76f458c4fa218f8799357d10d51e58cd264cb67583f802918bf0fb6f1ed` |
| introducing commit | `d437df4` — `1 file changed, 195 insertions(+)`, no other path touched |
| worktree HEAD at review time | `6648c80716b106e40285a2c344a6b5618199f7e9` |

## What changed since attempt 4

Nothing in the lane file: the sha256 above is byte-identical to the one attempt 4 recorded. The
failure `invalid_evidence` was **not** a defect of `scripts/diag-a.mjs`; it was my previous
submission's subject. Attempt 4 submitted a synthesised subject ("the current operation and
activation, with an explicit empty artifact identity") because `dependencySources['impl-a'][0].artifacts`
was empty. `verification.ts subject()` has nothing to match such an id against, so it threw.

This submission cites a real artifact version produced by `impl-a` **in its current operation**:

```
summaries/impl-a-gate-a-root-cause@3
id         3f9b635d-c0e5-46cd-9b0e-f7446fdebeda
path       /Users/macmini/Library/Application Support/Graph/state/artifact-workspace/objects/sha256/bb/bbcc988c80c9c6d4700b8497648dc8ecf52b293ebd14c2c69d5706b5d524c921
digest     bbcc988c80c9c6d4700b8497648dc8ecf52b293ebd14c2c69d5706b5d524c921
nodeId     impl-a
operationId  e73037e4-0715-44a3-9125-4c6442f9770f
activationId ce92e57e-9b09-4502-adad-9bf4cd2ef3ce
```

## correctness — pass

1. **Read-only, node builtins only.** `scripts/diag-a.mjs:19-21` imports only `node:fs`
   (`readdirSync`, `readFileSync`), `node:path` and `node:url`. A grep for
   `writeFile|appendFile|mkdir|unlink|rename|createWriteStream|openSync|exec|spawn` returns 0 hits.
   After three runs `git status --porcelain` reports nothing outside this review's own file.
   No dependency was added: the introducing commit changes exactly one path and leaves
   `package.json` / `pnpm-lock.yaml` untouched.

2. **Only one new file, no existing file modified.** `git show --stat d437df4` is
   `scripts/diag-a.mjs | 195 ++++` / `1 file changed`. No other `impl-a` code commit exists in the
   branch history (`git log --diff-filter=A -- scripts/diag-a.mjs` names `d437df4` only).

3. **Counts correct and repeatable.** Three consecutive runs exit 0 with empty stderr and produce
   byte-identical stdout (sha256 `c835b16890b8efaa3665d985499b3a69873272c573e42247a6168fa31de5abe6`):
   `测试文件 216 个，用例 1422 项`. Two independent corroborations:
   - a separate naive line-anchored regex scan (no comment/string stripping, written independently
     of the script) also yields `files 216 declarations 1422`;
   - `vitest list` registers 1426 runtime cases. The whole +4 delta is accounted for by two files
     that call `test()` inside a `for` loop — `tests/console/daemon-console.test.ts:17` (1
     declaration → 3 runtime) and `tests/console/schema-version.test.ts:92` (4 → 6). That is exactly
     the contract the script header states ("循环里运行的单个声明也只计 1"), so 1422 declarations is
     the right number for the declared metric, not a miscount.

   The file glob `tests/**/*.test.ts` matches `vitest.config.ts` `test.include`.

4. **Objective constraints hold.** `node --run typecheck` exit 0, `node --run lint` exit 0,
   independently rerun in this review.

## Residual blocker that no review submission can clear

`gate-a` is `multiview`, `subjectNode: impl-a`, required dimension `correctness`, `reportNode: review-a`.
Its verdict is computed from `operation.dependencySources` (see
`src/core/program-adapters.ts:39` and `src/core/verification.ts:293` for `multiview`). Every
persisted `gate-a` operation for this task carries:

```json
"impl-a": [{ "nodeId": "impl-a", "operationId": "…", "activationId": "…", "artifacts": [] }]
```

`loadGraph` fills that list from `result.artifacts` of the node's output operation
(`src/core/graph.ts:151`), and `impl-a`'s output `e73037e4` has result keys
`['outcome','output','usage']` — no `artifacts`. So `subject()`'s `find` runs over an empty array
and throws `Review does not apply to the current artifact version` for **every** report shape and
**every** subject, including this one. This is not a review defect and it is not fixable inside
review-a's file list; `handleRework` excludes `invalid_evidence` from progress, so the lane stalls
by design until one of these lands:

- populate `DependencySource.artifacts` from what the operation actually published
  (`execution.ts` `publishDeliverable` currently returns `result` unchanged, and
  `pi-adapter.ts` never sets top-level `artifacts`), **and**
- make the recorded `path` absolute. `artifactVersion()` requires `isAbsolute(path)`, so a
  workspace-relative `deliverable.path` in the source list can never be matched by any valid report;
- or resolve the subject from the artifact store in `subject()` by `artifactId` + producer node;
- or make the gate `independent`, which synthesizes its subject from the reviewer's own evidence.

Everything a reviewer can control is now correct: the subject is an exact artifact version of the
subject node in its current operation, and the required dimension is `pass` on independently
reproduced evidence.
