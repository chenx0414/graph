# review-b：scripts/diag-b.mjs

Verdict on dimension `correctness`: **fail**.

Reviewed only impl-b output `scripts/diag-b.mjs` at commit `8512b60a0ca8d87697c123ede078f654070c507a` (operation `199e3164-90dc-47a4-b3f8-83654183ddc4`, output version 1, activation `d82937d9-e068-4473-b780-28564bdf9fad`). The review worktree and the impl-b worktree are the same commit; `git diff --name-status 068bcd116d0ccb42daa9277ebf52ec85be7cc649..HEAD` is `A scripts/diag-b.mjs` only, and `git status --porcelain` is empty. Script sha256: `d6492876e43a27fb2d1572068c3539b8f4101fc9396771a1ff08a8b73fad2b98`.

## What holds

- Read-only on the default path. Imports are only `node:fs` (`readdirSync`, `readFileSync`, `statSync`) and `node:path`. No write, spawn, or network call. Two runs of `node scripts/diag-b.mjs` exited 0, produced identical stdout (`/tmp/review-b-evidence/diag-b-run1.txt` and `diag-b-run2.txt`, both sha256 `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`), and left the worktree clean.
- Default-tree counts are correct. Independent walk of `src/` with the same extension allowlist and editor line count: 197 files, 53800 lines, 7859068 bytes, same six module buckets, same extension totals, same top-10 files. No source file lacks a trailing newline, so a `wc -l` cross-check agrees. `node --run typecheck` and `node --run lint` both exited 0. `package.json` / lockfile are unchanged.

## Findings

### 1. No end-to-end proof was written before the script (R22 / R23 / R27)

`rules/common.md` is shared by every role and requires the failing test, or an end-to-end proof, before the implementation, plus a rerunnable artifact. Commit `8512b60` contains only `scripts/diag-b.mjs`. The note at `impl-b/docs/planning/acceptance-evidence/diag-b-independent/run.txt` is gitignored (`docs/planning/acceptance-evidence/*-independent/`), was written after the script (mtime after the commit), and is a pasted transcript, not a test that can fail. Nothing in the repository references `diag-b`, so a later wrong total, wrong bucket, or non-zero exit cannot be caught by `node --run check`.

Impact: the lane's acceptance ("统计结果是否正确、运行是否可重复") is not locked by a repeatable test. The shared testing standard treats this as a defect, not a style note.

Fix has to touch `scripts/diag-b.mjs` only if the proof lives beside the script; a separate test file is outside this lane's declared file. The lane owns no test path. That is stated here so the gate can mark it unowned rather than inventing a sibling file.

### 2. Documented optional root prints a wrong module and a path that escapes the repo

`scripts/diag-b.mjs` line 13 says `node scripts/diag-b.mjs [root]`, and line 23 resolves `process.argv[2]`. `moduleOf` (lines 49-52) then does `relative(repoRoot, file).split('/')` and, when the file is not under this repo, the first segment is `..`.

Reproduced: `node scripts/diag-b.mjs /tmp/diag-b-review-fixture/repo/src/core/a.ts` exited 0 and printed module `../..` and file `../../../../../../../../../tmp/diag-b-review-fixture/repo/src/core/a.ts`. The line count (1) was right; the module distribution was not. The impl-b note claims this single-file form lands in an `src/git` bucket; that only happens when the file is already inside this repo. The advertised `[root]` form does not.

Impact: a caller using the documented argument gets a module table that is not a module distribution. Default `src/` is unaffected.

Fix: `scripts/diag-b.mjs`.

### 3. One unreadable file aborts the whole diagnostic

Missing root is caught and exits 0 (`diag-b: cannot read source root ...`). A file `readdirSync` lists but `readFileSync` cannot open is not. Reproduced with mode `000` on a fixture file: exit 1, uncaught `EACCES` at `readFileSync` in `main` (the copy of line 91). The header says the script always exits 0 and is a diagnostic, not a check.

Impact: one unreadable source file yields no summary at all, so the run is not repeatable on a tree the process cannot fully read. Default `src/` has no such file, so this did not affect the 197/53800 result.

Fix: `scripts/diag-b.mjs`.

## Not raised as defects

- Empty `src/` prints `total ... 100.0%` and does not divide by zero, because the share formula runs only for module rows. No defect on the default tree.
- Symlinks are skipped (`Dirent.isFile()` is false). Not double-counted. Not claimed otherwise.
- `src/web/assets/graph-icon.png` is correctly excluded by the extension allowlist.
- impl-b published no artifact (`dependencySources.impl-b[0].artifacts` is `[]`; the node spec has no `deliverable`). A multiview report still has to name a subject the gate can match (`src/core/verification.ts` `subject()`), and a mismatch becomes blocker id `invalid_evidence`, which `handleRework` does not count as progress (`src/core/operation-lifecycle.ts`). That is a graph/harness gap, not a defect in `scripts/diag-b.mjs`. This report still names the only subject version the handoff supplies: operation `199e3164-90dc-47a4-b3f8-83654183ddc4`, output version 1. The file digest below is the script itself, because that is the reviewed bytes.

## Evidence files

- `/tmp/review-b-evidence/review-b.md` (this file)
- `/tmp/review-b-evidence/diag-b-run1.txt` sha256 `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`
- `/tmp/review-b-evidence/diag-b-run2.txt` same digest (repeatability)
