# review-c — `scripts/diag-c.mjs` (lane c, impl-c)

**Verdict: FAIL** — 1 blocking finding (silent false negative, one-line remedy). Every other
dimension passes. The failure is routed back to `impl-c` via the graph's declared `fail` edge.

## 1. Subject

| field | value |
|---|---|
| file | `scripts/diag-c.mjs` (new, 197 lines) |
| digest | `sha256 e40ab06ea1dbef8f419b8be1766067f0e560ca367e6819d3d3c1b1ef1c0dba16` |
| impl-c commit | `989ad2f` "diagnostics: add read-only npm scripts integrity checker" |
| on integration tip | `a695d7b` (merge of `d1d954a` + `989ad2f`) |
| published artifact | `summaries/impl-c-diag-c-evidence@1` — digest identical, subject is concrete |
| predecessor | impl-c op `1dbafb9d`, output v1, report `summaries/impl-c-lane-c-report@1` |

Digest re-computed in this worktree: matches. `git show --name-status 989ad2f` = `A scripts/diag-c.mjs`
and nothing else; `git diff --name-status d1d954a a695d7b` = the same single addition. **No existing
file was touched.** `git status --porcelain` on the review worktree is empty.

## 2. Blocking finding

### B1 — silent false negative: the entry guard is a raw string compare, so any symlinked path makes the tool exit 0 without checking anything

`scripts/diag-c.mjs:189`

```js
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
```

`import.meta.url` is always the **realpath**; `resolve(process.argv[1])` is not. If any component of
the path used to reach the script is a symlink, the two sides differ, `main()` never runs, and the
process exits **0 with no output at all** — indistinguishable from a clean run.

This directly refutes the file's own contract, header lines 20-21:

> Exit code: 0 when the script graph is complete, 1 when a problem is found.

An exit 0 that follows no check satisfies neither half. The header additionally claims the script is
"safe to run anywhere and its output can be treated as evidence" (lines 15-16); on these paths there
is no output to treat as evidence.

**This is broader than the defect impl-c reported.** impl-c described the trigger as "invoked
through a symlinked path". The real trigger is *any symlinked path component*, which on macOS is the
default for the two directories people actually use:

* `/tmp` -> `/private/tmp`
* `$TMPDIR` = `/var/folders/...` -> `/private/var/folders/...` (every macOS temp dir)
* any dev checkout reached through a symlinked parent directory

So "copy the script somewhere and run it" — the most natural thing a reader of the README will do —
lands on the silent path. For a diagnostic whose whole job is trustworthy output, silent success is
the worst available failure mode: it is strictly worse than crashing.

**Reproduction (deterministic, no repo state involved):**

```sh
T=$(mktemp -d /tmp/diag-c-repro.XXXXXX)
mkdir -p "$T/scripts"
cp scripts/diag-c.mjs "$T/scripts/"
printf '%s' '{"scripts":{"check":"node --run ghost"}}' > "$T/package.json"   # a definitely-broken repo

node "$T/scripts/diag-c.mjs";        echo "exit=$?"   # observed: exit=0, 0 bytes stdout, 0 bytes stderr   <-- WRONG, should be 1
node "$T/scripts/diag-c.mjs" "$T";   echo "exit=$?"   # observed: exit=0, 0 bytes stdout, 0 bytes stderr   <-- WRONG, should be 1

# same file, same arguments, only the spelling of the path differs:
node "$(cd "$T" && pwd -P)/scripts/diag-c.mjs" "$T"; echo "exit=$?"   # observed: exit=1, correct diagnosis
```

The last line is the control: identical bytes, identical arguments, `/private/tmp/...` instead of
`/tmp/...`, and the tool works. That isolates the cause to the guard's string comparison.

**Remedy — one line, proven.** Compare realpaths instead of resolved path strings:

```diff
-import { existsSync, readFileSync, statSync } from 'node:fs';
+import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
...
-if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
+if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
```

Verified on a **copy** in `/tmp` (the repo file was not modified by this review):

* via the symlinked `/tmp/...` path with no root argument: was `exit 0, 0 bytes` -> now
  `exit 1` and correctly prints ``check: references missing subcommand `ghost` ``;
* on the real repository: output **byte-identical** to the shipped script's output
  (`diff` clean), `exit 0` — no behavioural regression.

Optional companion: the header's "safe to run anywhere" claim should be dropped or the claim
reworded, since a silent no-op is the one thing a reviewer of the README will not expect.

## 3. Everything else: verified PASS

**Read-only.** Static scan for `writeFile*` / `mkdir*` / `rm*` / `unlink` / `rename` / `copyFile` /
`createWriteStream` / `spawn` / `exec*` / `child_process` / `fetch` / `openSync` / `truncate` /
`chmod` / `symlink` -> **0 hits** (the only `exec` matches are `pattern.exec(...)`, the regex API).
Dynamic proof: a `sha256` fingerprint of all **1026** tracked+untracked files (excluding `.git`,
`node_modules`, `.graph`) taken before and after three runs -> **identical**. The tree is provably
untouched, not merely claimed so.

**Node built-ins only.** Exactly 3 imports, all `node:`-prefixed:
`node:fs` (`existsSync, readFileSync, statSync`), `node:path` (`dirname, join, resolve`),
`node:url` (`fileURLToPath`). No dependency added; `package.json` untouched, so no lockfile drift.

**Counts are correct — independently recomputed with different code, not by re-running the tool.**

| claim in output | tool | independent recomputation | match |
|---|---|---|---|
| `scripts: 30 total` | 30 | `Object.keys(pkg.scripts).length` = 30 | yes |
| `5 reachable from check` | 5 | independent BFS over a hand-written regex -> `{check, check:evidence, lint, test, typecheck}` = 5 | yes |
| 19 file tokens all exist | 0 problems | re-extracted all 19 tokens and tested each with `fs.existsSync` -> 19/19 EXISTS | yes |
| `Problems: 0` | 0 | no missing subcommand, no missing file, no cycle, `check` present | yes |

The 5 reachable scripts are exactly the four leaves plus `check` itself, which is what
`"node --run typecheck && node --run lint && node --run test && node --run check:evidence"` implies.

**Repeatable.** Three consecutive runs: exit 0, `stdout` byte-identical, `stderr` 0 bytes. Also
cwd-independent — invoked from `/` with an absolute path, the output is identical after normalising
the echoed repository path.

**The tool actually detects things (black-box negative E2E).** `Problems: 0` is only meaningful if
the detector is capable of firing. Real file invoked against throwaway fixture repos on disk, no
mocks, no imports of the internals:

| fixture | expected | observed |
|---|---|---|
| clean chain `check -> a,b` | exit 0, `Problems: 0` | exit 0, `Problems: 0`, `3 total, 3 reachable` |
| `check: node --run ghost && node scripts/nope.mjs` | exit 1, both defects named with referrer | exit 1, `` check: references missing subcommand `ghost` `` + `` check: references missing file `scripts/nope.mjs` `` |
| cycle `check -> a -> b -> a` | exit 1, cycle reported once, terminates | exit 1, `cycle in script references: a -> b -> a` |
| package.json without `check` | exit 1, missing entry point | exit 1, `` no `check` script: the repo convention has no entry point `` |
| directory without `package.json` | exit 1, clear message | exit 1, `diag-c: no package.json found at ...` |
| `node /usr/bin/true.js` | — | exit 1, flagged `` references missing file `/usr/bin/true.js` `` (see N1) |

Exit codes, the `Problems: N` line and the referrer-prefixed messages are all correct, and the cycle
detector terminates instead of recursing forever.

**Repo checks on this commit.** `node --run typecheck` exit 0, `node --run lint` exit 0
(`No unawaited expect().resolves/.rejects chains found.`), `node --run check:evidence` exit 0
(`Acceptance evidence is unchanged.`).

## 4. Non-blocking observations (do not require a round)

* **N1 — absolute-path tokens are false-positive prone.** `FILE_TOKEN` (line 40) allows a leading
  `/` (`(?:\.{0,2}\/)?` matches a bare slash), so a script like `node /usr/bin/true.js` is resolved
  as `join(root, '/usr/bin/true.js')` = `<root>/usr/bin/true.js` and reported missing, although the
  path is absolute and may well exist. Confirmed by the last fixture row above. Harmless for this
  repo (all 19 tokens are relative), but it is a latent wrong answer for anyone who adopts the tool.
* **N2 — `findCycles` de-duplicates by node set, not by cycle.** The key is
  `[...new Set(cycle)].sort().join(' -> ')`, so two distinct cycles over the same node set collapse
  into one report. Diagnostics-only; exit code is unaffected.
* **N3 — no durable E2E harness.** The lane's own black-box harness lives in `/tmp`
  (`/tmp/diag-c-e2e/e2e.mjs`), so it does not survive the machine. My own evidence is fully recorded
  in this report (commands + observed output) so that it is at least reproducible, but the repo
  carries no regression test for the diagnostic. Constrained by the one-new-file lane rule; flagging
  as an R23 gap, not holding it against the lane.
* **N4 — no `package.json` entry point.** `diag-c` is not wired as a `diag:c` script, so it is
  invisible to `node --run check`. That follows from the "add exactly one new file" constraint and
  is correct for this task, but the README must tell users to invoke it by path.

## 5. Graph-level risk (not lane c's to fix)

`node --run test` is **red on the integration tip independently of this lane**: I ran it here —
`Test Files 42 failed | 175 passed (217)`, `Tests 128 failed | 1340 passed (1468)`. Lane c cannot be
the cause: `grep -rn "diag-c" tests/` returns **0** hits, so no test imports the new file, and the
failures are in `tests/m0/pi-process.test.ts`, `tests/console/compaction.test.ts`,
`tests/console/context-model.test.ts`, `tests/m8/system-self-improvement.test.ts` and siblings, with
signatures like `provider.requests[1]` being `undefined` (a scripted provider that never receives a
request) — environmental, not related to an added diagnostic. This corroborates `review-a@1` and
`impl-c`'s lane report.

Consequence for the graph: `full-tests` (`node --run check`) **will fail**, and the declared loop
`full-tests -> merge` cannot repair it — `merge` only writes a README. Without an operator decision
about the pre-existing red base, the task will loop `full-tests -> merge -> full-tests` until it
stalls. This needs to be surfaced to the operator, not worked around by the lanes.

## 6. What `impl-c` must do to clear this

1. Apply the one-line `realpathSync` guard fix from B1 (diff given above; verified working, output on
   the real repo unchanged).
2. Re-verify the B1 reproduction: via `/tmp/...` it must now exit 1 and print the diagnosis.
3. Re-run the three-run repeatability check and `node --run typecheck` / `node --run lint`.
4. Keep the file a single new file — do not touch `package.json` or any existing file.
5. Re-publish `summaries/impl-c-diag-c-evidence@2` with the new digest so the next reviewer binds to
   a concrete subject. Do **not** restore the old bytes: B1 is present in the digest this review
   approved (`e40ab06e`), so "restore the approved content" will not clear the finding.
6. Optional (do not block on these): N1 absolute-path handling, N2 cycle key, header wording.

No other dimension of lane c needs rework.
