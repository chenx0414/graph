---
name: verify-graph
description: "Drive the real Graph desktop app (Go + MyGo native window, plus its loopback daemon) and prove a user-facing feature works: launch an isolated instance, seed real data with a stub model, click through the accessibility tree, and leave AX snapshots, PNG frames, API reads and an exit code as evidence. Use for /verify-graph, \"does this Graph feature actually work\", \"prove the UI still works\", or before handing a Graph change to the user."
---

# verify-graph

Graph is a desktop app: one Go + MyGo binary (the window) and the same binary as `daemon` (loopback HTTP on
`127.0.0.1`, 120+ routes). This skill is the scripted way to answer "is this feature really usable?" without
clicking by hand and without trusting "it compiles".

Everything runs through one entry point, `verification/verify-graph`. It builds its own binary on first use.
Every command prints exactly one JSON envelope on stdout, human hints on stderr.

- `ok` is the verdict; `data` carries the details; `evidence[]` carries `{kind, path, sha256}` for everything
  that proves it.
- Exit codes: `0` ok, `1` a check failed, `2` usage, `3` environment (doctor), `4` timeout. `1` and `3` are
  different answers: a red check means the product is broken, `3` means this machine cannot judge yet.

Run every command from `verification/` (`cd verification`), or prefix with `go -C verification run ./cmd/verify-graph`.

## Launch

Isolated instance, empty data dir, ready when the daemon answers — not just when a process exists:

```sh
verification/verify-graph launch                     # view-only daemon, random port, .run/<run-id>/
verification/verify-graph launch --mode execute      # same, but the run may dispatch work
verification/verify-graph status                     # every run under .run/, plus orphans (reported, never killed)
```

What `launch` guarantees (this is the whole safety story; do not hand-roll `graphd` invocations instead):

- `--state-dir`, `--graph-home`, `--config` all live under `verification/.run/<run-id>/`. The user's real state
  (`~/Library/Application Support/Graph`) is read-only and never driven.
- `HOME`, `TMPDIR` and `PATH` are redirected for every child. `PATH` starts with a `launchctl` shim that logs and
  exits non-zero, so the window path can never `launchctl bootout gui/<uid>/dev.graph.daemon` and take the user's
  running daemon down with it.
- A window run uses a renamed build (`GraphVerify-<run>`), so MyGo's single-instance lock cannot hand our launch to
  the user's Graph.
- Ready means `GET /api/health` answers **and** `/api/conversations` refuses an unauthenticated call with 401 (the
  session cookie is really enforced). `launch` reports `readyMs` and the URL; the token never leaves the run dir.

Teardown is `cleanup` (see below), never `pkill`.

## Doctor

Run this first whenever anything looks off. It is read-only and answers "is this instance worth driving?":

```sh
verification/verify-graph doctor --run <run-id>
```

It checks: the run's daemon process and its `console.json` agree; `GET /api/health`; 401 without a cookie; the run
lives under `verification/.run` (isolated); the daemon binary is not older than the source it was built from; the
agent-desktop binary exists and its accessibility permission is `granted`; and the user's own Graph instance and
launchd service are untouched (fingerprinted before and after). A `3` exit from `doctor` means stop and fix the
environment — do not record a product failure.

## Which features exist

Read `features/index.json`; it is the list, and `FEATURE_MAP.md` at the repository root renders each entry against
the routes and handlers in the code. Do not keep a second copy of the list in this document — it would drift the
moment a feature is added, which is exactly the failure this skill exists to catch.

## Drive

Four lanes, pick the one the feature needs. Each one asserts on the real thing. `verify --all` runs the headless
lane for every journey and switches a journey to the surface lane when its file sets `surface`; `--lane window`
runs the same journeys through the real window instead.

**1. Headless render (real `app/` view code, no window, no screen permission).**
The fastest lane and the one that works on any machine: it runs the app's own `shellState.view` through MyGo's
tester, so the layout, labels and state transitions are the product's, not a mock.

```sh
verification/verify-graph ui render <journey> --run <run-id> --width 1440 --height 900
```

**2. Live accessibility tree (the real window).**
`ui snapshot` reads the window's AX tree; MyGo sets each element's AX name from its `Label()`, so the handles are
the product's own Chinese UI text (`轨迹`, `洞察`, `编队`, `供应商`, `资源`, `装配`, `设置`, `标签页 白板`,
`main agent 会话`, `消息`, `附件`, `模型`, `暂停`, `上下文` / `System Prompt` / `工具声明`).

```sh
verification/verify-graph ui snapshot --run <run-id> --app Graph
```

When the run has its own window process, `ui window open|click|shot|close` drives that window and captures it with
`ui shot`; use it instead of the `--app Graph` selector whenever two Graph windows can be on screen at once.
`ui window close` stops only the window; the daemon (and a seeded model) stays alive for the next command.

When you are still finding the exact label, drive the same window one control at a time. These verbs reuse the
run's own window process and write an AX JSON plus a PNG for each call, so what you learn is the same thing a
journey will later assert:

```sh
verification/verify-graph ui text --run <run-id>                                  # every AX name, as JSON
verification/verify-graph ui expect --run <run-id> --name 洞察概览窗口 --role group
verification/verify-graph ui click --run <run-id> --name 洞察 --expect 洞察概览
verification/verify-graph ui screenshot --run <run-id> --out evidence/<run>/manual/insights.png
```

Gotchas that cost runs: match on `role` + exact `name`, never substring (`find --text` also matches whole message
bodies); always scope to our own window (`--window-id`) because the user's Graph window has the same title and
agent-desktop answers `AMBIGUOUS_TARGET` when two instances match; inventory commands need a long
`--timeout-ms` (they report `APP_UNRESPONSIVE` at the 5s default); an element that reads `offscreen` can still be
clicked semantically; a stale ref answers `STALE_REF`, so re-snapshot instead of sleeping.

**3. Daemon API (state behind the UI).**
For setup and for reading the side effect the UI claims to have caused:

```sh
verification/verify-graph api GET /api/health --run <run-id>
verification/verify-graph api POST /api/conversations --run <run-id> --body '{"projectId":"verify","model":"seed","text":"hi","requestId":"r1"}'
```

The cookie and `Origin` header are added for you. Paths worth knowing: `/api/startup`, `/api/conversations`,
`/api/conversations/{id}`, `/api/conversations/{id}/trajectory`, `/api/tasks`, `/api/tasks/{id}/operations`,
`/api/fleet`, `/api/insights`, `/api/providers/magpie`, `/api/catalog`, `/api/settings`, `/api/config`,
`/api/state-machines`.

**Seed real data instead of asserting empty states.** An empty state dir renders "no sessions, no agents, no
usage", which proves nothing about fleet/insights/trajectory pages. `launch --mode execute --seed` starts a local
`openai-completions` stub model on loopback, points a `seed` model in the run's own config at it, and keeps serving
until `cleanup` stops it: the daemon really runs the agent loop, really calls the model, and really records a
trajectory with token usage — without credentials, network or cost.

```sh
verification/verify-graph launch --mode execute --seed --run <run-id>
verification/verify-graph api GET /api/startup --run <run-id>      # configured:true, modelCount:1
echo '{"projectId":"verify","model":"seed","text":"hi","requestId":"r1"}' > /tmp/body.json
verification/verify-graph api POST /api/conversations --run <run-id> --body "$(cat /tmp/body.json)"
```

The stub answers with `已就绪。这条回答来自验证用的替身模型…`, the conversation gains an `assistant` turn and
`/api/conversations/{id}/trajectory` records one request with token usage (`input 40 / output 10`). Verified on this
machine; `internal/seed` also has its own end-to-end test:

```sh
GRAPH_VERIFY_DAEMON="$PWD/.run/bin/graphd" GRAPH_VERIFY_REPO="$(cd .. && pwd)" \
  go test -run TestSeedingBuildsRealDataInAnIsolatedDaemon -v ./internal/seed/
```

`--seed` requires `--mode execute` (a view-only instance may not dispatch). Plain `launch` stays view-only with no
model, which is what the empty-state journeys expect: `/api/startup` then answers `configured:false, modelCount:0`,
and a `POST /api/conversations` leaves a `role:legacy` conversation with no assistant turn.

**Whole journeys.** A journey file pins one feature to its assertions and its evidence:

```sh
verification/verify-graph scenario run <journey> --run <run-id>
verification/verify-graph verify --run <run-id> --journey <id>
verification/verify-graph verify --all
verification/verify-graph verify --all --lane window
```

Journey file fields that change the lane: `instance: "execute"` (or a `seed` block) gets an execute-capable daemon
with the stub model, `surface: "menu-bar-extras"` drives a shell surface (F-15's tray), and everything else runs
headless on a view-only instance. `prepare`/`checks` are API reads: `expect` matches a **subset** of the JSON
value at a dotted path (extra fields on the response are ignored), `expectExact` requires the value to match
exactly. Use `expect` for live responses whose other fields move between runs.

## Evidence

Proof standard — a feature is `pass` only when all three exist, and any one missing makes it `evidence_partial`,
never `pass`:

1. **What the user sees**: an AX snapshot JSON (live window) or a PNG render frame (headless lane), plus the
   stable handles the journey asserted on.
2. **What the app actually did**: the daemon API read-back (message count, task state, revision, row count) or a
   file read (`whiteboard.json`, `graph.config.json`), not just the screen.
3. **A human can re-check it**: the PNG and the JSON sit in `verification/evidence/<run-id>/<feature>/`, listed in
   `assertions.json` and `summary.json` with a sha256 per file.

```sh
verification/verify-graph evidence list --run <run-id>
verification/verify-graph evidence verify --run <run-id>   # recompute the manifest hashes
```

Rules that keep the evidence honest:

- Never weaken a journey to make it pass; write the failing precondition into that feature's `Gotchas` instead.
- Exercise the user path, not an internal setter or a test-only endpoint. A `POST` that only the CLI calls is
  setup, not proof.
- Capture the action **and** the resulting state; a final screenshot alone cannot tell "clicked" from "was already
  open".
- Stub models are allowed exactly where production already isolates the boundary (an external model provider). The
  daemon loop, the scheduler, the store and the window stay real.
- No token, cookie, `secrets.json` or message body in evidence. Say `$HOME` as a hash prefix, never literally.
- Pixel capture needs a **region**, not the whole display: a `launchd` background session answers
  `could not create image from display` for bare `-x <path>` (and for agent-desktop's `screenshot`) while
  `permissions` still reports `screen_recording: granted`. `/usr/sbin/screencapture -x -R<x>,<y>,<w>,<h> <path>`
  with the window bounds from `list-windows` works. Verified on this machine: `-R0,0,400,300` produced a 123 KB
  PNG and `-R15,180,157,158` a 157×158 PNG of the app window. If the region capture fails too, mark the feature
  `evidence_partial` and say why; do not silently downgrade to an API-only pass.

## Control coverage

A journey proves that a feature works; a control witness proves that one button, tab, menu item or input was
really pressed/typed and that something visible changed afterwards. `verification/controls/` holds the list, the
witness ledger and the audited verdict. The rule is one conclusion per control: `covered`, `not-applicable` or
`blocked`; `unknown` is a red audit.

```sh
verification/verify-graph cover inventory --run <run-id>   # AX dumps -> controls/inventory.json
verification/verify-graph cover derive                     # green journey steps -> witnesses (never invents one)
verification/verify-graph cover audit                      # re-check every claim against journeys + evidence
```

How to judge a control:

- `covered` needs a real action step (`click`/`clickIf`/`type`/`key`) for that exact accessible name, an assertion
after it that observes a different visible result (or the typed value read back from the field), and a recorded
green run in a lane that can prove it. A screenshot, an `assertAccess` of the same label before the action, or a
`waitText` for the control itself does not count.
- `not-applicable` needs a concrete reason: one-off, external system, unreachable, or a dynamic label that cannot
be located stably.
- `blocked` needs the reason and the next step; record what was already tried under `attempts`.
- Menus, tray items, popups, focus and keyboard-only controls need a window/surface witness; headless cannot
pretend to prove them.

How to add a witness: write a scenario step that drives the control and asserts the result, run
`verification/verify-graph verify --journey <id>` (and `--lane window` when the control needs it), then run
`cover derive` and `cover audit`. The audit re-reads the journey file and the recorded `result.json`, so editing
the ledger alone cannot turn a control green. Full schema and a worked example: `skills/verify-graph/CONTROLS.md`.

## Cleanup

```sh
verification/verify-graph cleanup --run <run-id>    # stop the app, then the daemon, then remove .run/<run-id>
verification/verify-graph cleanup --all --dry-run   # list first; drop --dry-run to act
```

Cleanup only signals pids recorded in that run's `run.json`, after checking the process start time still matches
(no pid reuse). It never kills by process name, never touches the user's Graph, and never removes
`verification/evidence` — the proof outlives the instance. After stopping, it re-checks the launchd fingerprint and
the user's `console.json`; a change is reported as `isolation-violation`, not swallowed.

Orphans from abandoned runs are reported by `status`; `cleanup --orphans` stops only a daemon whose own
`--state-dir` is under `verification/.run/` and which no live run record owns, after re-checking its command line
and age (`--older-than`, default 120s). Review first with `--orphans --dry-run`.

## Helpers

- `verification/verify-graph` — the entry point shell. Builds `.run/bin/verify-graph` when the sources are newer,
  then execs it. Same arguments either way.
- `verification/skills/verify-graph/features/index.json` — the feature list: each entry carries its id, title, entry
  point, the API it touches and the scenario that proves it. `verification/scenarios/<id>.json` is the executable
  version of "how you drive this feature", and `verification/verify-graph verify --journey <id>` is how you run it.
  `FEATURE_MAP.md` at the repository root renders the same list against the code, so it cannot drift.
- `verification/controls/` — `inventory.json` (every stable control), `ledger.json` (witnesses/exclusions),
  `coverage.json` and `COVERAGE.generated.md` (the audited verdict). Schema and worked example in `CONTROLS.md`.
- `verification/internal/seed` — the stub model and the seeded conversation described under **Drive**.
- `verification/evidence/<run-id>/` — what a previous run proved; `evidence verify` re-checks the hashes.

## What this has proven so far

- `internal/seed` (unit): the stub provider streams `openai-completions` turns, calls a scripted tool exactly once
  when the turn offers it, and skips it when the turn does not; the config it writes is an executable
  `graph-openai` model with a `secretRef` credential, not a key; `Seed` creates one conversation, polls
  `/api/tasks/{id}/operations` until every operation is terminal, and reports a failed or stuck run instead of a
  green one.
- `internal/seed` (live): a real `graphd` on an isolated state dir, `--execute`, with the stub provider — one seeded
  conversation settled `succeeded`, the conversation held the messages the model produced, `/api/tasks/{taskId}`
  existed, and `/api/conversations/{id}/trajectory` recorded the request with real token usage
  (`input 40 / output 10`). Evidence: `verification/evidence/seed-b6t4n8x2/{seed.json,daemon.log}`.
