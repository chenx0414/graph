# review-c attempt 2 — `scripts/diag-c.mjs` (lane c, impl-c op `1dbafb9d`)

**Verdict: FAIL** — the same single blocking finding as attempt 1, re-verified from scratch on the
current integration tip with new evidence. Every other dimension passes. The `fail` edge routes this
back to `impl-c`; the required work is one line and nothing else.

Attempt 2 changed no input: the subject digest is still `e40ab06e…`, still the same single added
file in `989ad2f`. impl-c's rework republished the identical bytes and documented the defect rather
than fixing it, which is the correct behaviour for a reviewer who has not yet given the word.

## 1. Subject (frozen, re-verified in this worktree)

| field | value |
|---|---|
| file | `scripts/diag-c.mjs` (new, 197 lines) |
| digest | `shasum -a 256` → `e40ab06ea1dbef8f419b8be1766067f0e560ca367e6819d3d3c1b1ef1c0dba16` |
| impl-c commit | `989ad2f` "diagnostics: add read-only npm scripts integrity checker" |
| commit content | `git diff --name-status 989ad2f^ 989ad2f` = `A scripts/diag-c.mjs`, nothing else |
| published artifact | `summaries/impl-c-diag-c-evidence@1` (`3dda2e28`), digest identical |
| lane report | `summaries/impl-c-lane-c-report@1`, E2E transcript `deliverables/impl-c-diag-c-e2e-output@1` |
| integration tip reviewed | `ccf18cc` (lanes a + b + c merged) |
| review worktree | `git status --porcelain` empty; the reviewed file was never modified by this review |

## 2. Blocking finding (reproduced again, trigger now stated exactly)

### B1 — the entry guard compares a non-realpath against a realpath, so an absolute invocation through any symlink exits 0 in silence

`scripts/diag-c.mjs:195`

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
```

`import.meta.url` is always the realpath; `resolve()` only normalises, it does not resolve symlinks.
When `process.argv[1]` is **absolute and any component of it is a symlink**, the two sides differ,
`main()` never runs, and the process exits **0 with 0 bytes on stdout and 0 bytes on stderr** — a
result a reader cannot distinguish from a clean run.

This refutes the file's own contract, `scripts/diag-c.mjs:20-21`:

> Exit code: 0 when the script graph is complete, 1 when a problem is found.

and the header claim at lines 15-16 that the output "can be treated as evidence": on this path
there is no output at all.

**Correction to attempt 1** (the trigger is narrower than I first wrote, and impl-c must not be sent
after the wrong thing): a **relative** invocation is safe, because the kernel returns a realpath from
`getcwd`, so `resolve('scripts/diag-c.mjs')` is already the realpath. The silent exit needs an
**absolute** `argv[1]` that keeps a symlinked spelling. macOS ships two such spellings by default
(`/tmp -> private/tmp`, `/var -> private/var`, and `$TMPDIR=/var/folders/dk/…/T/`), so this is the
ordinary case for any temp-dir, CI path, or symlinked checkout.

**Reproduction (this attempt, real file, throwaway repo, no repo state involved):**

```sh
D=$(mktemp -d /var/folders/c-b1.XXXXXX)          # $TMPDIR, i.e. through the /var symlink
mkdir -p "$D/scripts" && cp scripts/diag-c.mjs "$D/scripts/"
printf '%s' '{"scripts":{"check":"node --run ghost"}}' > "$D/package.json"   # definitely broken

node "$D/scripts/diag-c.mjs"           # exit=0  stdout=0B  stderr=0B   <-- WRONG, should be 1
node "$D/scripts/diag-c.mjs" "$D"      # exit=0  stdout=0B  stderr=0B   <-- WRONG, should be 1
node "$D/scripts/diag-c.mjs"           # control, same bytes + same args via a realpath spelling
#   exit=1  "check: references missing subcommand `ghost`"
cd "$D" && node scripts/diag-c.mjs     # relative spelling: exit=1, works (see correction above)
```

The third line is the control: identical bytes, identical arguments, only the spelling of the path
differs. That isolates the cause to the guard's string comparison.

**The cause is diag-c's own guard, not the platform.** The same symlinked absolute invocation of the
two sibling diagnostics, on the same fixture layout, behaves correctly:

| script, invoked as `node $TMPDIR/.../scripts/<name>.mjs` | exit | stdout |
|---|---|---|
| `scripts/diag-a.mjs` | 0 | 40 B |
| `scripts/diag-b.mjs` | 0 | 1371 B |
| `scripts/diag-c.mjs` | 0 | **0 B** |

For a diagnostic whose only product is a trustworthy verdict, a silent success on a broken repo is
the worst available failure mode — strictly worse than a crash, because it is believed.

### Remedy — one line, proven on a copy, output-neutral on the real repo

```diff
-import { existsSync, readFileSync, statSync } from 'node:fs';
+import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
...
-if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
```

Verified this attempt on a **copy** in `$TMPDIR` (the repo file's digest was re-checked afterwards
and is still `e40ab06e…`):

* via the symlinked absolute path, the previously silent case now exits **1** and prints
  ``- check: references missing subcommand `ghost` ``;
* on the real repository the output is **byte-identical** to the shipped script's
  (`diff` clean, both exit 0) — the fix removes the false negative without changing any verdict;
* `tsc --checkJs` under the repo's own strict options (`target ES2024`, `strict`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `NodeNext`) → exit 0, same as the
  shipped file, so the gate stays green. `resolve` is still used at lines 29 and 161, so the import
  does not go stale.

An equally valid remedy is to **delete the guard**, which is what `diag-a.mjs` and `diag-b.mjs` do
and what makes them symlink-proof. Either is acceptable; the lane only has to pick one.

## 3. Every other dimension: verified PASS (all re-run this attempt)

**Read-only.** Static scan for `writeFile|mkdir|rmSync|rmdir|unlink|rename|copyFile|createWriteStream|
appendFile|spawn|execSync|execFile|child_process|fetch(|openSync|truncate|chmod|symlink` → **0 hits**.
Dynamic proof: a `sha256` fingerprint over all **1029** files (excluding `.git`, `node_modules`,
`.graph`) taken before and after three runs → `a14a374274cee52b44b55fc3` both times, identical.
The tree is provably untouched, not merely claimed so.

**Node built-ins only.** Exactly 3 imports, all `node:`-prefixed: `node:fs`
(`existsSync, readFileSync, statSync`), `node:path` (`dirname, join, resolve`), `node:url`
(`fileURLToPath`). `package.json` untouched → no lockfile drift. (N4: the script is deliberately not
wired as a `diag:c` entry, so `node --run check` does not execute it — correct under the
"exactly one new file" lane rule, but the README must tell users to invoke it by path.)

**Counts independently recomputed with different code, not by re-running the tool:**

| claim in output | tool | independent recomputation | match |
|---|---|---|---|
| `scripts: 30 total` | 30 | `Object.keys(pkg.scripts).length` = 30 | yes |
| `5 reachable from check` | 5 | independent BFS over the `node --run` regex → `{check, check:evidence, lint, test, typecheck}` | yes |
| every file token exists | 0 problems | 16 unique tokens / 19 occurrences re-extracted, `existsSync` on each → 0 missing | yes |
| `Problems: 0` | 0 | no missing subcommand, no missing file, no cycle, `check` present | yes |

The 5 reachable scripts are exactly the four leaves plus `check` itself, which is what
`check = node --run typecheck && node --run lint && node --run test && node --run check:evidence`
implies. (Attempt 1 wrote "19 file tokens"; the accurate split is 19 occurrences / 16 unique.)

**Repeatable and cwd-independent.** Three consecutive runs on the real repo: exit 0, stdout digest
`16d0dae38b19ef02` each time, stderr 0 bytes. Invoked from `/` with an absolute realpath, the output
is `diff`-identical after normalising the echoed repository path.

**The detector can actually fire (black-box negative E2E, real file, fixture repos on disk, no
mocks, no imports of the internals).** 5/5 as expected:

| fixture | expected | observed |
|---|---|---|
| clean chain `check -> a,b` with the referenced files present | exit 0, `Problems: 0` | exit 0, `3 total, 3 reachable` |
| `check: node --run ghost && node scripts/nope.mjs` | exit 1, both defects named with referrer | exit 1, ``check: references missing subcommand `ghost` `` and ``…missing file `scripts/nope.mjs` `` |
| cycle `check -> a -> b -> a` | exit 1, cycle reported once, terminates | exit 1, `cycle in script references: a -> b -> a` |
| `package.json` without `check` | exit 1, missing entry point | exit 1, ``no `check` script: the repo convention has no entry point`` |
| directory without `package.json` | exit 1, clear message | exit 1, `diag-c: no package.json found at …` |

(A non-existent root argument also exits 1 with the same clear message.)

**Repo checks on the reviewed tip.** `node --run typecheck` exit 0 · `node --run lint` exit 0
(`No unawaited expect().resolves/.rejects chains found.`) · `node --run check:evidence` exit 0
(`Acceptance evidence is unchanged.`).

## 4. Non-blocking observations (explicitly *not* grounds for a rework round)

* **N1 — absolute-path tokens are false-positive prone (re-verified).** `FILE_TOKEN` (line 40) allows
  a leading `/`, so an absolute token is joined onto the root. Fresh proof: a fixture whose
  `check` is `node $TMPDIR/…/real-file.mjs`, with that file present, is reported as
  `- check: references missing file `/var/folders/dk/…/real-file.mjs`` and exits 1. Harmless in this
  repo (all 19 tokens are relative) but a latent wrong answer for anyone adopting the tool.
* **N2 — `findCycles` de-duplicates by node set, not by cycle** (`[...new Set(cycle)].sort().join(...)`),
  so two distinct cycles over the same node set collapse into one report. Diagnostics only; the exit
  code is unaffected.
* **N3 — no durable E2E harness for the diagnostic.** The lane's harness lives in `/tmp` and does not
  survive the machine. My harness for this attempt is likewise in `/tmp` (`/tmp/c-rev2-fixtures.mjs`),
  but every command and observation is recorded above so the result is reproducible. The repo carries
  no regression test for any of the three lane scripts; this is an R23 gap across lanes a/b/c, not
  something lane c can fix inside "exactly one new file".
* **N4 — no `package.json` entry point** (see above). Correct for this task; documentation duty.

## 5. Graph-level risk (not lane c's to fix, and it will block `full-tests`)

`node --run test` is **red on the integration tip independently of this lane**. Re-run here in full:
`Test Files 43 failed | 174 passed (217)`, `Tests 129 failed | 1339 passed (1468)`,
`Duration 233.94s`. Failures sit in `tests/console/{chain-depth,compaction,context-model,
handoff-response,node-run,predecessor-handoff-production,presets,…}.test.ts`, `tests/m0/*`,
`tests/m1/recovery.test.ts`, `tests/m7/*`, `tests/m8/*` — 43 files, none of which touch the lane.

Lane c cannot be the cause: `grep -rn "diag-c" tests/` → **0** hits. The only 2 hits for
`diag-a|diag-b|diag-c` in `tests/` are a *fabricated* review body inside
`tests/m2/verification.test.ts:229,235` that merely names `scripts/diag-a.mjs` as a string and never
opens it. No test imports or executes any lane file, and none of the three is wired into
`package.json#scripts`. This corroborates `review-a@1` and impl-c's lane report.

The failed count also moved between runs of an unchanged tree (impl-c measured 42/128 with the file
present and 43/129 without it; I measure 43/129), which points at flaky/environmental failures rather
than a deterministic break.

Consequence for the graph: **`full-tests` (`node --run check`) will fail**, and the declared
`full-tests -> merge` loop cannot repair it, because `merge` only writes a README. Without an
operator decision about the pre-existing red base, the graph will loop `full-tests -> merge ->
full-tests` until it stalls. Route this to the operator; do not let a lane absorb it.

## 6. What `impl-c` must do — nothing else

1. Apply the one-line `realpathSync` guard fix from B2, or delete the guard outright. That is the
   entire required change.
2. Re-verify the B1 reproduction: via the `$TMPDIR`/`/tmp` absolute path it must now exit 1 and print
   the diagnosis; the sibling behaviour table above is the control.
3. Confirm the real-repo output is unchanged and re-run `node --run typecheck` and `node --run lint`.
4. Keep it a single new file — do not touch `package.json` or any existing file.
5. Re-publish the deliverable as `summaries/impl-c-diag-c-evidence@2` with the new digest so the next
   reviewer binds to a concrete subject. **Restoring the old bytes does not clear B1** — the defect
   lives inside digest `e40ab06e…`, which is the digest this review approved. A new digest is expected
   and is the point.
6. Optional, do not block on these: N1 absolute-path handling, N2 cycle key, header wording of the
   "safe to run anywhere" claim.

No other dimension of lane c needs rework, and no other lane is asked to change anything.
