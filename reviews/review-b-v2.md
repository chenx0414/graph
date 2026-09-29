# review-b：scripts/diag-b.mjs（当前产物，impl-b output v2）

Verdict on dimension `correctness`: **pass**.

Reviewed the current impl-b output, not the previous one. Predecessor handoff is operation `c779ec77-5d47-4d73-a04f-0a1b3a99bb5b`, output version 2, activation `d4c30644-0d18-479f-b440-37ab4bf55878`. The bytes under review are `scripts/diag-b.mjs` at commit `31b829b37d5e2010b97a813158f77af50ccf76bd` (sha256 `b34a89ae4717b15eb5b4f50b14f3eaacf2701c2fcc802e24d9510d0fc3c1eeb4`, 10359 bytes). The previous review (`reviews/review-b@1`) named operation `199e3164-90dc-47a4-b3f8-83654183ddc4` / commit `8512b60` / digest `d6492876…`; gate-b rejected that report as `invalid_evidence` because it does not apply to the current artifact version. This report does not reuse that subject.

impl-b still publishes no `OperationResult.artifacts` entry (`result` keys are `outcome`, `output`, `usage` only; `graph.sources` therefore has an empty artifact list). The subject below is the only identity the current handoff supplies, bound to the script bytes that were actually counted.

## What was rechecked on the current bytes

- Lane boundary. `git diff-tree --name-status` for `8512b60`, `50eb7be` and `31b829b` is only `scripts/diag-b.mjs` (`A` then two `M`). `git status --porcelain=v1 --untracked-files=all` is empty. `node scripts/diag-b.mjs --self-test` leaves that status empty.
- Default `src/` counts. Two runs from the worktree and one from `/tmp` all exited 0 with identical stdout (sha256 `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`): 197 files, 53800 lines, 7.5 MB. An independent walk with the same extension allowlist and editor line count got 197 files, 53800 lines, 7859068 bytes, the same six module buckets, the same extension totals, and the same top-10 files. No source file lacks a trailing newline.
- Previous findings, on this version:
  - `node scripts/diag-b.mjs /tmp/diag-b-review-fixture-v2` exited 0 and labelled modules `deep` and `diag-b-review-fixture-v2`. It did not print `../..`. A single file outside the repo was labelled `deep`, with an absolute display path.
  - mode `000` on one fixture file: exit 0, that file listed under `unreadable (skipped)`, the readable sibling still counted.
  - missing root: exit 0, stderr `diag-b: cannot read source root …`, empty stdout.
  - `node scripts/diag-b.mjs --self-test` twice: exit 0, identical stdout. A copy whose expected total was changed to 99 files exited 1 and left no `diag-b-selftest-*` directory in `/tmp`.
- Diagnostic imports are Node builtins only (`node:fs`, `node:os`, `node:path`). `writeFileSync` / `mkdirSync` / `rmSync` / `mkdtempSync` appear only inside `--self-test`, which writes under `tmpdir()` and removes that directory in `finally`. The default path does not write. No `child_process`, spawn, or network call.

## Not a defect in this file

`src/core/verification.ts` `subject()` still requires the report subject to equal an entry in `dependencySources.impl-b[].artifacts`. That list is empty for this operation, so no subject this node can name will match, and a mismatch is blocker id `invalid_evidence` (not counted as progress). That binding is outside `scripts/diag-b.mjs` and outside this lane's file list. It is recorded so the gate does not treat a correct script as an unfixed defect. No `files` entry is attached to the pass judgment, because a pass does not name a fix.

## Evidence

- `/tmp/review-b-evidence-v2/run1.txt` sha256 `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`
- `/tmp/review-b-evidence-v2/run2.txt` same digest
- `/tmp/review-b-evidence-v2/selftest1.txt` sha256 `8dd2a5302a7b545f53473a4df2d5926e8ed9e4a1086cfe8f5fb28adca5cc57bd`
- `/tmp/review-b-evidence-v2/outside-root.txt` sha256 `19750bc9db33d7cac51386e4ca1810a0648dad9b044228f8a0832abde5b6b1b8`
- `/tmp/review-b-evidence-v2/eacces.txt` sha256 `0a7712b26d522df3bb0d7d8b99cdee20cbff9de4ff6c9f933fdd4968d41ed34b`
- `/tmp/review-b-evidence-v2/single-file.txt` sha256 `a81761074544838efd4d351dffe2184133bafd570aed26bc7e6a3235a0466153`
