# agent-desktop capability

The computer-use capability of this project: a thin Graph tool over the
[`agent-desktop`](https://github.com/vercel-labs/agent-desktop) CLI (1.1.0,
protocol 2.6, Apache-2.0), plus the upstream skill vendored beside this file.

- `SKILL.md` — the upstream guide (verbatim, after the marker) with the Graph
  wiring, the permission rules and the two gotchas that cost a run on top.
- `references/platform-macos.md` — the upstream macOS guide, verbatim.
- `.agents/agent-desktop-skills-lock.json` — repository, version, protocol,
  license and the sha256 of every vendored source.
- `.agents/agent-desktop-LICENSE` — Apache-2.0, the license of the vendored text.

## The tool

One tool named `desktop`, declared only on a host that has the CLI:

| argument | meaning |
| --- | --- |
| `command` | one agent-desktop subcommand (`snapshot`, `click`, `type`, `focus-window`, `clipboard-get`, `session`, …) |
| `args` | the subcommand's flags and arguments, verbatim (`--headed` is refused here) |
| `headed` | `true` only for a gesture that has to be physical: on macOS it takes focus and moves the real cursor |
| `include` | `"output"` returns the payload of a command whose output is withheld by default |

The result is the CLI's own JSON envelope. A refusal travels byte for byte,
`disposition` included; the host never repeats a call, so a repeat is only ever
the caller's decision, made from `disposition.retry` (`"safe"` is the only value
that authorises one).

`snapshot`, `find`, `get`, `is`, `screenshot`, `clipboard-*`, `batch`, `trace`
and `list-*` are withheld unless `include: "output"`: the answer is a receipt
with `bytes`, `sha256` and what kind of payload it is. Screen and clipboard text
never enter an artifact, a log line, a completion notice or a message by
default, and the wrapper writes none of them anywhere on its own.

## Where the CLI comes from

Resolution order (`ResolveDesktopBinary`):

1. `GRAPH_DESKTOP_BIN`, when it names an executable.
2. The capability library: `<graph home>/capabilities/agent-desktop/node_modules/.bin/agent-desktop`,
   then the platform binary that package launches.
3. `agent-desktop` on `PATH`.

A host with none of them declares no `desktop` tool at all rather than a tool
that always fails.

## Permissions and authorisation

These are the two binaries macOS must authorise. Both are adhoc, linker-signed
with `TeamIdentifier=not set` (`codesign -dv`), so the grant is what makes them
usable at all:

```
/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64
/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop/node_modules/agent-desktop/bin/agent-desktop-macos-helper-darwin-arm64
```

The launcher the user may authorise instead is `/Applications/Graph.app`.

**Authorisation is not a permanent state.** TCC identifies an adhoc binary by its
path plus its cdhash, so reinstalling, upgrading or moving the install changes
the cdhash and invalidates the grant. After any install change, run
`agent-desktop permissions` and read the answer instead of assuming the
capability still works.

The tool asks that question before it asks which target was meant: for the
commands that read the accessibility tree (`snapshot`, `find`, `get`, `is`,
`click`, `type`, `focus-window`, …) a missing grant answers `PERM_DENIED` with
`error.details.source = "graph-desktop-tool"` and `disposition.retry = "safe"` -
never a target error, because "I cannot see the screen" and "I cannot tell which
element you meant" have different fixes. Only a grant that is readable as granted
lets a target error through, and when `permissions` says granted while a call
still fails, that refusal is passed through untouched and reported as the
inconsistency it is.

Read that answer from a host context only. A sandboxed caller — the Agent's own
shell, a test executor — reports `denied` even after the grant, and that reading
is a false negative rather than evidence about the host.

The one step only the user can take: run `agent-desktop permissions --guide`
from the app that launches the CLI, drag that app into the Accessibility list,
switch it on, and repeat for Screen Recording if screenshots are needed.

## What the host verified

On 2026-11-03, in the host context (`sandbox: false`, the RSI check runner), the
loop ran for real against Finder:

1. `snapshot --app Finder -i` → 836 elements, each with a `ref_id`.
2. `click <ref_id>` on a cell → `ok: true`.
3. `snapshot --app Finder -i` → 108 elements and a different summary: the UI
   really changed.
4. `click <the old ref_id>` → `error.code = STALE_REF`,
   `disposition.delivery = not_delivered`, `disposition.retry = "safe"`.
5. Re-snapshot, `click <a fresh ref_id>` → `ok: true`.

Before and after screenshots (1.6 MB each) were kept in a local directory as
local evidence: not an artifact, not a log line, not a message.

`tests/e2e/desktop-capability.test.ts` covers the parts of this that run in a
sandboxed executor (envelope passthrough, headless default, withheld payloads,
the vendored digest, the tool budget) and reports the permission state it
actually sees. Its interactive Finder loop runs only from a host context, and
says so when it does not run.

## Re-vendoring

```sh
agent-desktop version                      # 1.1.0, protocol 2.6
agent-desktop skills get desktop           # data.content → SKILL.md, after the marker
agent-desktop skills get platform          # data.content → references/platform-macos.md
```

Update the version, protocol and the per-file `sha256` in
`.agents/agent-desktop-skills-lock.json` in the same commit: the E2E test
recomputes both digests from the installed binary and fails when the vendored
text is not exactly what that version compiles in.
