---
name: agent-desktop
tags: computer-use, desktop-automation, accessibility, ai-agent, gui-automation, cli
requirements:
  - agent-desktop
description: >
  Operate desktop applications on macOS, Windows and Linux through native accessibility trees,
  using the agent-desktop CLI. Use when an AI agent must see or act on a desktop GUI:
  click buttons, fill forms, read UI state, navigate menus, toggle checkboxes, scroll,
  drag, type text, press shortcuts, take screenshots, manage windows, use the clipboard,
  launch or close apps, read notifications.
  Triggers on: "click button", "fill form", "open app", "read UI", "computer use",
  "operate desktop", "accessibility tree", "snapshot app", "type into field", "navigate menu",
  "toggle checkbox", "take screenshot", "desktop automation", "agent-desktop",
  or any desktop GUI task on macOS, Windows or Linux.
source_repository: https://github.com/vercel-labs/agent-desktop
source_version: 1.1.0
source_protocol: "2.6"
source_license: Apache-2.0
source_license_file: .agents/agent-desktop-LICENSE
source_lock: .agents/agent-desktop-skills-lock.json
source_skill: "agent-desktop skills get desktop"
source_platform_skill: "agent-desktop skills get platform"
vendored_path: .agents/skills/agent-desktop/references/platform-macos.md
---

# agent-desktop, wired into Graph

This skill is upstream text, vendored so it can never drift from the binary the
tool runs: provenance, version and license are in the front matter and in
`.agents/agent-desktop-skills-lock.json`, and the untouched guide follows the
marker at the end of this file.

## One tool, `desktop`

Graph declares one tool, not sixty: `desktop` takes `command` (any agent-desktop
subcommand) plus `args`, and answers with the CLI's own JSON envelope. Read
`agent-desktop <command> --help` or `skills get <name>` for the flags; do not
guess them.

- **Headless by default.** The tool never adds `--headed` on its own. On macOS
  `--headed` is physical first: it takes focus and moves the real cursor, so it
  exists only as the explicit argument `headed: true`, and only for a gesture
  that has to be physical (hover, drag, double-click, raw coordinates).
  `--headed` inside `args` is refused, because a flag that arrives as a string
  arrives without its warning.
- **Screen and clipboard output is withheld** unless you ask: `snapshot`, `find`,
  `get`, `is`, `screenshot`, `clipboard-*`, `batch`, `trace` and `list-*` come
  back as a receipt (`bytes`, `sha256`, what kind of payload it is) so a private
  message or a password cannot land in a transcript by accident. Ask again with
  `include: "output"` when you actually need the tree or the clipboard text.
- **Refusals come back verbatim and nothing is retried for you.** The host never
  repeats a call: a repeated click is a second click. Repeat one yourself only
  when the envelope's `disposition.retry` is `"safe"`, and re-observe first when
  `disposition.delivery` is `not_delivered`.

## Two things that cost a run each

- **The ref field is `ref_id`, not `ref`.** Each snapshot node carries
  `children`, `name`, `native_id`, `role`, `states`, `available_actions`,
  `ref_id`, `description` and `value`. A click takes the `ref_id` string.
- **`agent-desktop screenshot` returns `TIMEOUT` on this host.** Take evidence
  with `/usr/sbin/screencapture -x <local path>` instead, keep it in a local
  directory, and never publish it as an artifact, a log line or a message.

## Permissions, and the one thing that is not a permanent state

- **Only a host context reads permissions truthfully.** Run
  `agent-desktop permissions` from Graph's own host process or the user's
  terminal. A sandboxed caller - the Agent's own shell, a test executor - reports
  `denied` even after the user granted the permission. That reading is a false
  negative, not evidence.
- The two binaries macOS authorises are adhoc, linker-signed builds with
  `TeamIdentifier=not set` (`codesign -dv`):
  - `/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop/node_modules/agent-desktop/bin/agent-desktop-darwin-arm64`
  - `/Users/macmini/Library/Application Support/Graph/capabilities/agent-desktop/node_modules/agent-desktop/bin/agent-desktop-macos-helper-darwin-arm64`
- The launcher the user may authorise instead is `/Applications/Graph.app`.
- **Authorisation is not a permanent state.** TCC identifies an adhoc binary by
  its path plus its cdhash, so reinstalling, upgrading or moving the install
  changes the cdhash and silently invalidates the grant. After any install
  change, run `agent-desktop permissions` and look at the answer before assuming
  the capability still works.
- The launcher adds about 125 ms per call (npm did not run the package's install
  script, so the CLI runs through its Node launcher). It is a cost, not a defect.

## What the host verified on 2026-11-03

`snapshot --app Finder -i` returned 836 elements carrying `ref_id`; a click on a
cell changed the window, and the next snapshot returned 108 elements with a
different summary; the old `ref_id` then answered `STALE_REF` with
`disposition.delivery = not_delivered` and `disposition.retry = "safe"`; a fresh
snapshot's `ref_id` clicked successfully. Before and after screenshots (1.6 MB
each) stayed in a local directory: local evidence, not an artifact, not a log
line, not a message.

<!-- vendored from `agent-desktop skills get desktop`, agent-desktop 1.1.0, Apache-2.0 -->

# agent-desktop

agent-desktop is a CLI that lets an AI agent observe and operate desktop apps through the OS accessibility tree. It is a tool, not an agent. Every command prints one JSON envelope (`ok`, `data` or `error`). The observe, act and verify loop runs in you.

## Shell syntax

Examples use a POSIX shell. In PowerShell, quote every ref (`'@s8f3k2p9:e1'`), because a bare `@token` is the splatting operator. Use `$env:NAME = 'value'` instead of `export`, and `| ConvertFrom-Json` instead of `$(...)` and `jq`. The Windows skill has the PowerShell forms.

## First run

1. Run `agent-desktop status`. It reports the platform, permissions and `supported_surfaces`.
2. Run `agent-desktop skills get platform`. It loads the skill for the OS the binary runs on (macOS, Windows or Linux).
3. For flags and syntax, run `agent-desktop <command> --help`. This skill does not repeat flag lists.

## The loop

Use `find` when you know the role or exact name. Otherwise map the app first and drill into one region.

```
agent-desktop snapshot --skeleton --app "Notes" -i --compact   # shallow map, children_count on cut branches
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # drill into one region
agent-desktop click @s8f3k2p9:e12                              # act on a qualified ref
agent-desktop snapshot --root @s8f3k2p9:e3 -i --compact        # verify: re-read the same region
```

- A small app needs no skeleton. Take a full `snapshot -i`.
- `-i` keeps interactive nodes only, so a row's static-text label is dropped. To tell which row a repeated button belongs to, drill that row's container with `--root` and leave out `-i`. On Windows and Linux that reads the row but does not make its button actionable: a button repeated in other rows is a twin in the window and its ref is refused (see Refs).
- A `--root` drill adds its refs to the same snapshot id. Refs outside the drilled subtree, and the drilled root itself, stay valid; refs that were already inside it are replaced, so an old ref there returns `STALE_REF`.
- Never skeleton a surface (`--surface menu`, `sheet`, `alert`). A surface is already focused.
- An action that opens a menu, sheet or alert lists it in `data.surfaces`. Target that overlay next.
- After an async step, use `wait` (see `commands-system.md`). A fixed sleep is a race.

## Refs

- Output refs are qualified: `@<snapshot_id>:e<N>`, for example `@s8f3k2p9:e1`. Pass them to later commands as they are.
- Refs are valid for one snapshot. After any UI change, re-drill the affected region or take a new snapshot.
- Only addressable elements get refs. Static text and inert containers do not.
- A command re-identifies the element before it acts. On macOS the ref carries the element's own address, so identical twins each keep their ref. On Windows and Linux a ref resolves only when it was the only element in the window its snapshot captured with its role, native id, name and description, counted even below a skeleton or depth cut, and exactly one live element still matches. Identical twins there have no ref path: only `--headed mouse-click --xy X,Y` can choose one, it takes the foreground, and a Linux Wayland session refuses it.
- `STALE_REF`: the element is gone or no longer matches. `details.kind` is `saved_ref_absent`, or `retained_object_stale` on macOS. Take a fresh snapshot and use the new ref.
- `AMBIGUOUS_TARGET`: an identical element appeared (`saved_ref_ambiguous`), or the ref was not proven unique at capture (`identity_not_unique`). Repeating the ref or re-snapshotting identical twins gives the same refusal; act on a control that is unique in the window. `identity_not_unique` also follows a snapshot that could not read the whole window in time: retake it with a larger `--timeout-ms`.
- `TIMEOUT` with `details.kind: resolution_identity_unknown`: a live read did not answer, so identity is unproven. Nothing was sent; retry.
- `SNAPSHOT_NOT_FOUND`: the snapshot id expired. Snapshot again.

## Delivery and retry

Action results carry `data.disposition` and errors carry `error.disposition`, each with `delivery` and `retry`. Observation commands such as `snapshot` have none on success; their errors, and every `INVALID_ARGS` refusal, carry `not_delivered` and `retry: safe`.

- Retry or substitute an action only when `disposition.retry` is `safe`. Only `not_delivered` is safe.
- Any other delivery value means the action may have landed. A repeat can click, type or submit twice, and `toggle` can undo itself.
- On a result that is not safe, read the live state (`get`, `is`, or a fresh snapshot) and decide from that. `details.post_state` helps when present.
- Branch on `error.code` and `error.disposition`. Message and suggestion text can change.
- `details.retryable: false` means waiting cannot change the outcome. Try a different approach.

## Headless and headed

Ref actions are headless by default. They use semantic accessibility calls and do not take focus, move the cursor, synthesize keys or use the clipboard. If no semantic path exists, the action fails closed. Use the global `--headed` flag only when the user explicitly permits physical input, such as double-click, hover, drag, or focus. Never switch to headed mode to recover from a headless failure. Raw coordinates (`--xy`) never imply focus. Which actions need `--headed` differs by OS: read the platform skill.

## References

Load one only when you need it: `agent-desktop skills get desktop <reference>`.

| Reference | Open it when |
|-----------|--------------|
| `commands-observation` | You need `snapshot`, `find`, `get`, `is`, `screenshot`, `list-surfaces` semantics, partial trees, or the `--root` rules |
| `commands-interaction` | You choose between click, type, set-value, select, toggle, scroll, press and mouse commands, or you debug an action error |
| `commands-system` | You launch or close apps, manage windows, use the clipboard, `wait`, `batch`, sessions, multi-agent cursors, tracing, or load skills |
| `workflows` | You want worked patterns (forms, menus, dialogs, waiting for a new window, scroll-find, drag) and the anti-patterns list |
