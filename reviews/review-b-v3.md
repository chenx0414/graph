# review-b：scripts/diag-b.mjs（当前产物，impl-b output v3）

Reviewed the current impl-b output, not the previous one. Predecessor handoff is operation `5488505c-32ac-433a-b5b7-d262c1e018d2`, output version 3, activation `c15df0ee-56bb-4ade-92d4-d33139b6c191`, instance `2a1963c9-648d-45b2-bb51-2cb48d5a9b0e`. The bytes under review are `scripts/diag-b.mjs` at commit `31b829b37d5e2010b97a813158f77af50ccf76bd` (sha256 `b34a89ae4717b15eb5b4f50b14f3eaacf2701c2fcc802e24d9510d0fc3c1eeb4`, 10359 bytes). That commit is an ancestor of this worktree; `git diff-tree --name-status -r 31b829b` is only `M scripts/diag-b.mjs`. `reviews/review-b@2` named the previous operation `c779ec77-5d47-4d73-a04f-0a1b3a99bb5b` / output version 2 and was rejected as stale. This report replaces that binding.

## Verdict

`correctness`: pass.

The current operation result has keys `outcome`, `output`, `usage` only. `result.artifacts` is absent, so `graph.sources(impl-b).artifacts` is `[]`. `src/core/verification.ts` `subject()` requires the report subject to equal one of those entries on id, path, digest, nodeId, operationId and activationId. There is no such entry, and the handoff does not supply an artifact id. Naming a guessed subject would still be rejected as `invalid_evidence`. That binding is outside `scripts/diag-b.mjs` and outside this lane's file list. It is not a defect in the script.

The published escalation note `deliverables/shape-a-artifact-binding-defect@1` (artifact `b5ec21d4-d62d-4535-95c7-a5b048cd0ffd`, digest `f9368a0c0b9cde60d69dced51619b45af2f5538945be8d8654ed0e060a46786b`) is the current handoff's explanation of that gap. It is not the script under review.

## Look-for

- Read-only, node builtins only. Imports are `node:fs`, `node:os`, `node:path`. Diagnostic mode only reads. `--self-test` writes a temp fixture and removes it in `finally`.
- Lane boundary. The script bytes are still the v2 commit. This worktree is clean aside from this review file. Running the script and `--self-test` did not change `scripts/diag-b.mjs`.
- Counts and repeatability.
  - Two default runs were byte-identical: 197 source files, 53800 lines. An independent walk of `src/` with the same extensions and skip set counted the same 197 / 53800.
  - Outside the repo, the module label was the file's own directory (`deep`), not `../..`. The display path was absolute.
  - One unreadable file was skipped and the process exited 0. A missing root exited 0 with `diag-b: cannot read source root …` and empty stdout.
  - `node scripts/diag-b.mjs --self-test` exited 0 and printed PASS. It left no `diag-b-selftest-*` directory.

## Evidence

- `/tmp/review-b-evidence-v3/run1.txt` sha256 `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`
- `/tmp/review-b-evidence-v3/run2.txt` same digest
- `/tmp/review-b-evidence-v3/selftest.txt` sha256 `8dd2a5302a7b545f53473a4df2d5926e8ed9e4a1086cfe8f5fb28adca5cc57bd`
- `/tmp/review-b-evidence-v3/outside-root.txt` sha256 `6cae9d6e7d240bbf2377f2e1ba685df0a254dd47ef313ae0d83aeaf95250bf83`
- `/tmp/review-b-evidence-v3/eacces.txt` sha256 `1872c4217063305327f23ff0a8b50bc9524d0f2f1510205d781c8922f2c69091`
- `/tmp/review-b-evidence-v3/missing-stderr.txt` sha256 `900e82cc5863cdb0064792fd0b1fcfec9b073025351ed9acc2c1717e817300de`
