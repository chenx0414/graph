# review-c — independent review of lane c (`scripts/diag-c.mjs`)

Verdict: **PASS** (route: `pass`)

## Subject under review (frozen, bound to exact version)

- File: `scripts/diag-c.mjs`
- Commit: `45f01ac` (`git rev-parse HEAD` in this work copy == `45f01ac8b226df77e4b4f2e0a6a4896346c08ad5`)
- sha256: `31c1fb057112cc2b7480c2bf0734a00389b64bec17b2d609e9364135ba18e3e3`
- Bound artifact: `summaries/impl-c-diag-c-script@1`,
  artifactId `b925880d-c0d7-4f1f-9868-13f704c5ce26`
  (recomputed from the work copy: exact match)
- Harness: `deliverables/impl-c-diag-c-e2e-harness@1`,
  artifactId `965781ae-5dfa-4466-8681-c823a50174c8`, sha256 `1fe439e0…` (recomputed: match)
- Evidence: `summaries/impl-c-diag-c-evidence@1`,
  artifactId `e2df7141-2e4e-4657-bda4-e1c3ce71953d`

## Scope

Focus: only impl-c's output. Assertions the lane must satisfy:
read-only; only node builtins; only one new file and no existing file changed;
statistics correct; runs repeatable.

## What I ran (all rerunnable, run by the reviewer, this work copy)

1. `node scripts/diag-c.mjs` in the review work copy → exit 0, `Problems: 0`.
2. Determinism: 3 consecutive runs → identical sha256 `95950dee…`; a run from `/tmp`
   (cwd-independent) → same hash.
3. Static inspection: `import` lines only `node:fs`, `node:path`, `node:url`;
   no `child_process`/`spawn`/`execSync`/`writeFile*`/`mkdir`/`unlink`/`process.chdir`
   (the two `exec(` hits are `RegExp.exec`).
4. Whole-tree read-only fingerprint (`find … stat -f '%N %z %m' | sha256`):
   `cbf7b8c7a32a876008062371e25a8fe334f12fbc5ace683d33d7f39368108374`
   **identical before and after** every run; `git status --porcelain` empty.
5. Provenance: `git show --name-status 45f01ac` → `A scripts/diag-c.mjs` (single file);
   `git diff --name-only cd43de6 45f01ac` → only `scripts/diag-c.mjs`;
   `git rev-list --parents -n1 45f01ac` → single non-merge parent.
   No existing `package.json` script references `diag-c`.
6. Published harness, run by the reviewer: `node <harness> "$PWD"` → **54 passed, 0 failed, exit 0**.
   `--self-check` → harness *fails* a fake always-clean subject, so it is not a tautology.
7. **Independent adversarial fixtures (not the lane's harness)**, to test the exact
   fixes and the correctness claims on my own inputs:
   - symlinked argv[1] (dir symlink, file symlink, macOS `/tmp` symlink): output identical
     to canonical spelling and exit 1 — no silent no-op (fix verified).
   - existing absolute path token is **not** reported missing; a genuinely missing one is
     (fix verified).
   - three distinct cycles sharing nodes (`alpha↔beta`, `beta↔gamma↔delta`, `self`) all
     reported once each, terminates (rotation keying verified).
   - reachable-from-`check` BFS on a synthetic chain → 5 of 6, correct and terminating.
   - error paths: no `package.json` → clean one-line exit 1; malformed JSON → clean
     message exit 1, no stack trace.
   - independent recount of the real manifest: 30 total scripts / 5 reachable, and every
     file token resolves — matches the script's own report.

## Findings

No blocking defects. Every focus item verifies (see "What I ran").

### Minor / non-blocking (recorded, do not gate this lane)

1. **Directory satisfies a file reference.** `diagnose` tests path existence with bare
   `existsSync`, while `readScripts` uses `statSync(...).isFile()` for `package.json`.
   A *directory* named `scripts/foo.mjs` therefore resolves as present. Verified with a
   fixture (`mkdir scripts/foo.mjs` → exit 0, "OK"). The docstring says "file path …
   not on disk", so the narrower `isFile()` used elsewhere would be more faithful.
   Not triggered by this repository: no directory with a code extension exists in the
   real tree. Files a fix would touch: `scripts/diag-c.mjs`.

2. **Bareword mis-parsed as a path.** A token such as `some.mjs.ext` is truncated at the
   first code extension and reported as a missing file `some.mjs`. Verified with a fixture.
   Harmless heuristic false positive; the real `package.json` contains no such token
   (harness S7c and my independent recount both confirm all real tokens resolve).
   Files: `scripts/diag-c.mjs`.

### Cross-lane note (not a defect in this lane)

`diag-c` is not yet referenced by any script; the `check` chain
(`node --run typecheck && node --run lint && node --run test && node --run check:evidence`)
does not exercise the three diagnostics. impl-c deliberately left this to merge/integration;
I agree it belongs to the merge lane, not here.

## Verdict

Lane c passes its own review. The script is read-only, uses only node builtins, adds
exactly one new file without touching any existing file, reports correct statistics, and
is byte-for-byte repeatable. The two fixes impl-c flagged after the previous round hold
under independent reproduction. Route: `pass`.
