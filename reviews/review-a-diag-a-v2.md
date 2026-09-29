# review-a：scripts/diag-a.mjs（当前产物，impl-a output v2）

Verdict on dimension `correctness`: **pass**.

Reviewed the current impl-a output, not the previous one. Predecessor handoff is operation `d60ffcef-06bf-48fb-af38-99fc545fcd35`, output version 2, activation `0e34e8f1-ea97-4ac0-b60b-5e30ffe1f4bb`. The published handoff for that operation is `summaries/impl-a-gate-a-root-cause@1` (`3f9b635d-c0e5-46cd-9b0e-f7446fdebeda`, digest `0ce77c25fd64bd2b96bc9823ee745ecbc842ae13f661d3c020e0c8543c6bf45d`, 3799 bytes). The previous review (`reviews/review-a-diag-a@1`) named operation `cc9eb9d0-7c39-42bf-b1a9-23bc95180d7e` / artifact `c0b75dd8-4fa3-4e66-9d5b-3402911b7c6b`; gate-a rejected that report as `invalid_evidence` because it does not apply to the current artifact version. This report does not reuse that subject.

The bytes under review are still `scripts/diag-a.mjs` at commit `d437df46ab6c108e36625c4c13f28f86d13067eb` (sha256 `3903d76f458c4fa218f8799357d10d51e58cd264cb67583f802918bf0fb6f1ed`, 6209 bytes). That commit is an ancestor of HEAD, and `git diff d437df4 HEAD -- scripts/diag-a.mjs` is empty, so output v2 did not change the file. The current handoff says the same thing: nothing new was written in this lane.

## What was rechecked on the current bytes

- Lane boundary. `git diff-tree --name-status -r d437df46ab6c108e36625c4c13f28f86d13067eb` is only `A scripts/diag-a.mjs`. No `package.json` or lockfile change. `scripts/diag-b.mjs` and `scripts/diag-c.mjs` belong to other lanes.
- Read-only and builtins only. Imports are `node:fs` (`readdirSync`, `readFileSync`), `node:path`, and `node:url`. The source has no `writeFile`, `appendFile`, `mkdir`, `rm`, `unlink`, `rename`, `createWriteStream`, `child_process`, `spawn`, `exec`, or network call.
- Default count. `node scripts/diag-a.mjs` from this worktree exited 0 and printed `[diag-a] 测试文件 216 个，用例 1422 项（tests/**/*.test.ts；每个 test/it 声明计 1 项，test.each 按声明计 1）`. An independent walk of `tests/**/*.test.ts` got 216 files. The same line-start `test`/`it` declaration pattern, including `.each`, counted 1422. That include matches `vitest.config.ts`.
- Repeatability. The count above is the same number the previous review recorded for these unchanged bytes, and this run's stdout matches that recorded line. `test.each` is counted as one declaration, which the file header states; that is not the runtime expansion `vitest list` would print.

## Not a defect in this file

`src/core/verification.ts` `subject()` still requires the report subject to equal an entry in `dependencySources.impl-a[].artifacts`. That list is built only from top-level `result.artifacts` (`src/core/graph.ts`). The current operation result keys are `outcome`, `output`, and `usage`; `result.artifacts` is absent, so the list is empty. No subject this node can name will match, and a mismatch is blocker id `invalid_evidence` (not counted as progress). That binding is outside `scripts/diag-a.mjs` and outside this lane's file list. It is recorded so the gate does not treat a correct, unchanged script as an unfixed defect. No `files` entry is attached to the pass judgment, because a pass does not name a fix.

Non-blocking, unchanged from the previous review of these bytes: the header says the process exits non-zero when `tests/` is missing, but `main()` does not catch `readdirSync` ENOENT. `tests/` exists, so the delivered count is unaffected.

## Evidence

- `/tmp/review-a-evidence-v2/run1.txt` is this run's stdout.
- `reviews/review-a-diag-a-v2.md` is this report.
- The current handoff object is `/Users/macmini/Library/Application Support/Graph/state/artifact-workspace/objects/sha256/0c/0ce77c25fd64bd2b96bc9823ee745ecbc842ae13f661d3c020e0c8543c6bf45d` (sha256 `0ce77c25fd64bd2b96bc9823ee745ecbc842ae13f661d3c020e0c8543c6bf45d`).
- The reviewed script is `scripts/diag-a.mjs` (sha256 `3903d76f458c4fa218f8799357d10d51e58cd264cb67583f802918bf0fb6f1ed`).
