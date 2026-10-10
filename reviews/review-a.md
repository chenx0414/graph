# review-a — independent review of `scripts/diag-a.mjs`

**Operation:** 82c07c76-cf14-4d55-b2b7-3692417900a2 · **Activation:** 8f4b1c34-49e9-4edb-b53a-464ca57e4d20
**Lane:** review-a (router) · **Subject:** `scripts/diag-a.mjs`, commit `47232b3` (parent `cd43de6`),
blob `314578f31aa93dad5c3bf1c52600834fc64bc824`, 123 lines / 5315 bytes.
**Verdict: PASS.**

I did not read the implementation transcript. Every claim below was reproduced in this worktree with
read-only tools. Where a prior round published evidence, I re-ran it or re-derived the number myself.

## 1. Scope and frozen identity — verified

| Claim | How I checked | Result |
| --- | --- | --- |
| commit `47232b3`, parent `cd43de6`, 1 file / 123 insertions | `git show --stat 47232b3`, `git rev-parse 47232b3^` | matches |
| blob `314578f3…` | `git rev-parse HEAD:scripts/diag-a.mjs` | matches |
| subject unchanged at HEAD | `git diff 47232b3 HEAD -- scripts/diag-a.mjs` | empty |
| no sibling lane touched in the commit | `git show --name-only 47232b3` | `scripts/diag-a.mjs` only |
| work tree clean | `git status --porcelain` | empty |

`git diff cd43de6 HEAD -- scripts/ tests/ src/` also lists sibling `diag-b.mjs` / `diag-c.mjs`,
which belong to **other lanes** and are outside this subject. Nothing in the reviewed commit adds or
edits them.

## 2. The script does what it claims — independently recomputed

I re-derived every number the script prints without reusing its code:

```
node scripts/diag-a.mjs            → exit 0, SUMMARY files=217 declarations=1456 uncollected=1
find tests -name '*.test.ts'       → 217
find tests -name '*.test.*'        → 218   (uncollected = 1: tests/fixtures/m7/web-server.test.js)
find tests -name '*.test.ts' | grep -Eo '(^|[^A-Za-z0-9_$.])(test|it)(\.[A-Za-z]+)*[[:space:]]*\(' → 1456
node_modules/.bin/vitest list --filesOnly → 217
```

The `*.test.ts` shape is not a guess: `vitest.config.ts` sets `include: ['tests/**/*.test.ts']`, so
the file count is a fact about what vitest collects. The reported `uncollected` exactly equals the
`*.test.*` set vitest does not collect.

## 3. Contract clauses — verified

* **Builtins only.** The only imports are `node:fs`, `node:path`, `node:url` (lines 31–33).
* **Read-only.** A token scan for `writeFile*/mkdir/rm/rename/unlink/spawn/exec/fork/fetch/http/https/net/Date.now/new Date/process.env/process.cwd/Math.random` in the *code* (comments excluded) finds none. A `path:size:mtime` fingerprint over the work tree (`node_modules`/`.git` pruned) is identical before and after a run, and `git status` stays clean.
* **Deterministic.** 3 runs, all exit 0, empty stderr, byte-identical stdout (`sha256 88a5220623e444a1…`).
* **cwd-independent.** Running the script by absolute path from `/tmp` prints the same bytes with exit 0. (My first attempt used `$(pwd)` after `cd /tmp` and hit `MODULE_NOT_FOUND` — that was my harness bug, not the script's.)

## 4. Testing standard (R22/R23/R27) — the one judgment call

The node's declared file list is `scripts/diag-a.mjs` only, and **no in-repo test file was added**;
the acceptance mechanism is an out-of-repo E2E harness. I checked whether that is a breach:

* Repo convention: of ~10 sibling `scripts/*.mjs`, exactly one (`skills-lint.mjs`) has an in-repo
  test (`tests/console/skills-lint.test.ts`). Adding no test is the norm here, not an exception.
* The harness is a real E2E: it is black-box (spawns the script), shares no logic with the subject
  (recounts with shell `find`/`grep`, cross-checks `vitest list`), fingerprints ~1000 work-tree files
  around a run, and was run to green by me.
* I re-ran the **published, frozen** harness bytes (`deliverables/impl-a-diag-a-e2e-verification@1`,
  digest `416eee809780109f7963f09e91428e45f94d0bd6fdaa22c90bdf9559353532f7`, matching the on-disk
  file): `result: 24/24 checks passed`, exit 0, report written.

Conclusion: no R23 breach. There is a genuine, acknowledged limit — the harness lives in `/tmp`, so
`node --run test` cannot exercise it and the green run is only as durable as that artifact. That is
why a small in-repo test (e.g. `tests/console/diag-a.test.ts` spawning the script and asserting
`SUMMARY files=217 …`) would strengthen the node. I record it as an **optional follow-up, not a
blocking defect**, since the declared scope excludes it and the repo does not require it. impl-a
raised this openly rather than hiding it, which is the right call.

## 5. `node --run check` fails — confirmed pre-existing, not this lane

`node --run test` here: **42 failed files / 128 failed tests** (217 files, 1480 cases). I reproduced
the sorted failing-file list and hashed it:

```
sha256(d5e63dcd18f9cb396406642b3c106f80157206c5658ad06c0abcb4ab2fdfcf79)
```

That digest is **byte-identical** to both lists the report publishes
(`/tmp/impl-a-e2e/fail-baseline.txt` and `fail-with-diag-a.txt`), and identical to the list I
generated at this HEAD. `typecheck`, `lint` and `check:evidence` all exit 0. `cd43de6` does not
contain `scripts/diag-a.mjs` (`git cat-file -e` fails), so the failures exist without the subject.
The failing tests are environment-shaped (`Test timed out in 15000ms`, `graph.command` node
`pending` vs `succeeded`).

**Consequence for the graph:** the downstream `full-tests` node will fail on the integration copy and
its edge will bounce back. That is not fixable by this lane — it is identical with the file deleted.
The verifier/operator should treat it as an environmental blocker, not a rework of diag-a.

## 6. Findings

No blocking defects. No regressions. No unsupported claims: every number, digest and pass/fail
statement in `summaries/impl-a-diag-a-report@1` reproduces exactly.

| # | Severity | Finding | Files a fix would touch |
| --- | --- | --- | --- |
| 1 | note (non-blocking) | Acceptance test lives outside the repo, so `node --run test` cannot cover it; durability rests on the `/tmp` artifact. Optional: add an in-repo test. | `tests/console/diag-a.test.ts` (does not exist yet) |

## 7. Verdict

**PASS.** The subject is a small, safe, deterministic read-only diagnostic; its scope is exactly one
new file; every claim is independently reproducible; and the only failing check is pre-existing and
environmental. Routing `pass`.
