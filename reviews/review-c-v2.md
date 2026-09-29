# review-c: scripts/diag-c.mjs (current impl-c output v2)

Reviewed the current impl-c output, not the previous one. The gate input for this review operation (`9aa8ac79-1ecc-4405-b42b-e69e8ba14d8d`) binds exactly one source:

- nodeId `impl-c`
- operationId `b02cdfd3-ff8f-4ccb-b6ff-c16cb9e5f0e0`
- activationId `f791c1b0-1ae9-4600-9998-501f660ff68d`
- outputVersion `2`
- artifacts `[]`

That is the predecessor named in this rework. The previous review targeted operation `843b5ebb-86da-4789-8d9b-fc2169cd1c4f` / activation `0a9f821c-d8be-46d2-9826-c8a20a80a53c` and was rejected as stale. This report replaces that binding.

The bytes under review are `scripts/diag-c.mjs` at commit `cd456a6b629d410b32b1c7e5f81eae2a0f2d6d83` (sha256 `e40ab06ea1dbef8f419b8be1766067f0e560ca367e6819d3d3c1b1ef1c0dba16`, 6432 bytes, git blob `f44b780666bd52fd50d2f038d99138ec59c66805`). That commit is an ancestor of this worktree. `git diff-tree --name-status -r cd456a6` is only `A scripts/diag-c.mjs`. The current operation result has `changes: []`; the script hash matches the committed blob.

## Verdict

`correctness`: pass.

The current operation result keys are `outcome`, `output`, and `usage`. `result.artifacts` is absent, so `dependencySources.impl-c[0].artifacts` is `[]`. `src/core/verification.ts` `subject()` requires the report subject to equal one of those entries on id, path, digest, nodeId, operationId and activationId. There is no such entry. Naming the published note `research/impl-c-gate-c-root-cause@1` (`ee13bb80-df0e-4a10-a870-1a084724e1d5`, digest `717a9a57f1600065c2b06f91e18e1ff256bbb6bd292c170445692bbb78e7b425`) would still be rejected: it is not in the source artifact list. Inventing a subject is what the previous gate called `invalid_evidence`. That binding is outside `scripts/diag-c.mjs` and outside this lane's file list. It is not a defect in the script.

## Look-for

- Read-only, node builtins only. Imports are `node:fs`, `node:path`, and `node:url`. Default mode only reads. Two default runs left the script hash unchanged.
- Lane boundary. The only file this lane added is `scripts/diag-c.mjs`. `package.json` is unchanged. No dependency was added.
- The question the script claims to answer holds on the current tree. An independent walk of `package.json#scripts` found 30 scripts, no missing `node --run` / `npm run` / `pnpm run` / `yarn run` target, and no missing referenced file. `check` is present and expands to `typecheck`, `lint`, `test`, and `check:evidence`.
- Repeatable evidence.
  - Two default runs exited 0 and were byte-identical: 30 scripts, 5 reachable from `check`, Problems: 0.
  - A fixture with a missing file, a missing subcommand, and a mutual `a -> b -> a` cycle exited 1 and reported all three.
  - A self-cycle (`check -> check`) exited 1. A missing `package.json` exited 1 with `diag-c: no package.json found at …`.
  - Importing the module did not run `main()`.

## Evidence

- `/tmp/review-c-evidence-v2/run1.txt` sha256 `c041dbfc3eb1735bf54c150944fc6aa867832313b28e11c56a7557f8e36f38ff`
- `/tmp/review-c-evidence-v2/run2.txt` same digest
- `/tmp/review-c-evidence-v2/fixture-out.txt` sha256 `6991288a502d4d3feeb76d492e8e277b2c805992bb1a4b361c14d779f211a523`
- `scripts/diag-c.mjs` sha256 `e40ab06ea1dbef8f419b8be1766067f0e560ca367e6819d3d3c1b1ef1c0dba16`
