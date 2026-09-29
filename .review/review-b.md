# review-b — attempt 7 (gate-b: multiview, subject impl-b, dimension `correctness`)

Subject reviewed (re-read from the task store in this attempt):

- node: `impl-b`
- operation: `5488505c-32ac-433a-b5b7-d262c1e018d2`
- activation: `c15df0ee-56bb-4ade-92d4-d33139b6c191`
- output version: 3
- `result` keys: `outcome`, `output`, `usage` — **no top-level `artifacts`**
- `node_write_captures` rows for `impl-b`: 0

## Verdict

`correctness`: **unresolved** for the gate's subject version. The file itself passes every look-for
(detail below), but the gate cannot bind a subject, and `correctness` is a claim about a bound
subject, so this lane cannot certify the dimension while the subject is unresolvable.

This replaces the previous report, which answered `pass` and called the binding gap "a harness
problem, not a lane defect". That was wrong in a way that cost the graph a full rework loop: the
defect is in **impl-b's submitted result**, which is the lane's own output, and it is the only thing
the gate can bind against.

## Why the gate cannot bind a subject (the blocking finding)

Frozen input, read from the gate operation `fcd0aade-f659-475d-9f3c-851e8e2871ce` (`spec.dependencySources`):

```
impl-b -> [{ activationId: c15df0ee-…, artifacts: [], operationId: 5488505c-…, outputVersion: 3 }]
```

`src/core/graph.ts:151` builds `DependencySource.artifacts` solely from `OperationResult.artifacts`.
That field is absent, so the list is empty. `subject()` in `src/core/verification.ts:90-97` then has
nothing to match against:

```ts
const artifact = current.find(item => sameArtifact(item, reported)) ?? current.find(item => sameContent(item, reported));
if (!artifact) invalid('Review does not apply to the current artifact version');
```

Both `sameArtifact` and `sameContent` require a `nodeId: 'impl-b'` entry, so **no** `subject` a
reviewer can legally write resolves. `evaluateMultiview` calls `subject()` before it reads any
dimension (`src/core/verification.ts:206`), so the dimension verdict is never reached and
`program-adapters.ts:47-56` converts the throw into the `invalid_evidence` rework blocker with an
empty evidence list. The previous report's message changed nothing; this one names the fix.

### The fix, and it belongs to `impl-b`

`OperationResult.artifacts` is the Agent's own submission field (`src/core/types.ts:245`,
validated at `src/core/operation-lifecycle.ts:1074-1076`: unique non-empty ids, absolute paths,
64-hex sha256 digests). impl-b must include, in its `submit_result` payload:

```json
"artifacts": [{ "id": "scripts/diag-b.mjs",
                "path": "<absolute path of scripts/diag-b.mjs in the impl-b worktree>",
                "digest": "b34a89ae4717b15eb5b4f50b14f3eaacf2701c2fcc802e24d9510d0fc3c1eeb4" }]
```

Publishing the same bytes as a task artifact is fine and additionally useful, but the published
artifact alone does **not** bind the gate: `publishDeliverable` (`src/core/execution.ts:601-636`)
publishes and returns without touching `result.artifacts`, so `dependencySources` stays empty.

`files` for this finding: `scripts/diag-b.mjs` (impl-b's only deliverable; the graph plan gives
impl-b no `input.files`, so the gate will report it as unowned and the main Agent can extend the
lane's file list in one revision).

## Correctness evidence for `scripts/diag-b.mjs`

File under review: `scripts/diag-b.mjs`
sha256 `b34a89ae4717b15eb5b4f50b14f3eaacf2701c2fcc802e24d9510d0fc3c1eeb4`
git blob `5f6b047ea72b43ece262fd095f649166397913c9`
Byte-identical in all seven worktrees of this task (`impl-a`, `impl-b`, `impl-c`, `integration`,
`review-a`, `review-b`, `review-c`) and at this worktree's HEAD `6648c80`.

### Look-for 1 — read-only, node builtins only: holds

- Imports are only `node:fs`, `node:os`, `node:path` (`scripts/diag-b.mjs:21-22`).
- The three write calls (`mkdtempSync`, `mkdirSync`, `writeFileSync`) and `rmSync` exist only inside
  `selfTest()` (`scripts/diag-b.mjs:167-176`, `:213-215`) and target a fresh `mkdtemp` root removed
  in `finally`. Diagnostic mode calls `render(root, collect(root))` and nothing else
  (`scripts/diag-b.mjs:222-229`).
- End-to-end proof, not code reading: `find` for anything newer than a marker set before a default
  run reports **0** paths outside `node_modules/.git/.review`
  (`.review/diag-b-write-check.txt`).

### Look-for 2 — exactly one new file, nothing else touched: holds

- The three lane commits each touch exactly one file: `8512b60` (A, +135), `50eb7be` (M, +125/-28),
  `31b829b` (M, +3/-1) — all `scripts/diag-b.mjs`. No `package.json`, no lockfile, so no dependency
  was added.
- `git status --porcelain` in the impl-b worktree is empty.

### Look-for 3 — counts correct and repeatable: holds

- Two default runs are byte-identical: both sha256
  `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08`
  (`.review/diag-b-run-1.txt`, `.review/diag-b-run-2.txt`).
- Independent recount with a separate walker, not the script, applying the script's **documented**
  extension rule: 197 files, 53800 lines, 7859068 bytes; `src/web` 63/17936, `src/core` 44/13863,
  `src/runtime` 55/13467, `src/server` 16/4738, `src/catalog` 16/2526, `src/git` 3/1270; every
  extension row identical (`.review/diag-b-recount.txt`).
- The only file the walk does not count is `src/web/assets/graph-icon.png`, excluded by the
  documented `SOURCE_EXTENSIONS` rule (`scripts/diag-b.mjs:26`: "Anything else (images, fonts) is
  skipped, not guessed"). Counting it would give 198/57370; that gap is intended, not a lost file.
- `--self-test` exits 0 and reports the hand-written fixture expectation
  (`.review/diag-b-self-test.txt`).
- `node --run typecheck` and `node --run lint` both exit 0 on this tree, as impl-b's objective requires.

## Repeatable artifacts of this review (this worktree)

| file | sha256 |
| --- | --- |
| `.review/diag-b-run-1.txt` | `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08` |
| `.review/diag-b-run-2.txt` | `7b381471075493c8c0cdc85ac93f1c00d54ba550d5a5e6fc3578559c1bee3c08` |
| `.review/diag-b-self-test.txt` | `8dd2a5302a7b545f53473a4df2d5926e8ed9e4a1086cfe8f5fb28adca5cc57bd` |
| `.review/diag-b-recount.txt` | `aca5efc9698d73bdc63b477c52d6a828ddb1769a11d5311414f5c89e74f48aab` |
| `.review/diag-b-write-check.txt` | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |

## Not raised as failures

- `main()` swallows any `collect()` error into one line and exits 0, including `ENOENT` on the
  default root. Documented as intended ("a diagnostic that dies on one bad input is not usable") and
  it prints the failing root, so it stays diagnosable.
- Unreadable files are listed and skipped instead of aborting the report (documented).
- The harness files `src/core/graph.ts`, `src/core/verification.ts`, `src/core/program-adapters.ts`
  and `src/core/execution.ts` are named in this report for traceability only. **No fix is owed in
  them** for acceptance `b-pass`: a lane that declares an artifact binds fine today, which is how
  every other verifier path works.
