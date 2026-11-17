# Control coverage

> Conclusion and commands are stable; the numbers below are a snapshot. Regenerate them with
> `./verify-graph cover audit` (machine truth: `controls/coverage.json`, `controls/COVERAGE.generated.md`).

## Conclusion

Graph's feature journeys prove that pages work. This round adds the control-level question: **was every stable
button, tab, menu item and input really driven, with a visible result afterwards?**

- Every control in `controls/inventory.json` has exactly one conclusion: `covered`, `not-applicable` or `blocked`.
  `unknown` is an audit failure.
- A `covered` claim is not a label: the audit re-reads the journey file and the recorded run. It requires the
  action step (`click`/`clickIf`/`type`/`key`), a later assertion that observes a **different** visible result (or
  the typed value read back from the field), a green recorded step, and a lane that can prove the control
  (window/surface for menus and tray).
- Screenshots alone, `assertAccess` of the clicked label before the action, and `waitText` for the clicked label
  itself do not count as witnesses.
- `./verify-graph verify --all` stays the feature-level gate; `./verify-graph cover audit` is the control-level gate.
  Both must be green before `FINAL`.

Latest snapshot (2026-11-17, after `cover inventory` + `cover derive --refresh`):

| metric | value |
| --- | --- |
| controls in the stable UI | 94 |
| covered | 81 |
| not-applicable | 12 |
| blocked | 1 |
| unowned (audit red) | 0 |
| journeys cited by witnesses | 19 |
| lanes proven | headless, surface, window |

Numbers move as journeys land. Read the authoritative table in `controls/COVERAGE.generated.md`, or run
`./verify-graph cover audit` and read `data.total / covered / notApplicable / blocked / problems`.

The current audit is green: every control has exactly one conclusion. 81 were really driven (rail, tab strip,
board panels, composer/model picker/send, context tabs, fleet filters, provider search/refresh, resource filters,
settings, assembly detail, and the tray's `打开 Graph`); 12 are honestly not-applicable; 1 is blocked with a next
step.

## Commands

```sh
cd verification

# 1. Build the control list from the real window's accessibility tree
./verify-graph cover inventory --run <run-id>          # merge every AX dump a window run left
./verify-graph cover inventory --ax pages/fleet.json --page fleet --feature F-10   # or one page at a time

# 2. Turn already-green journey steps into witnesses (never invents one, never overwrites a human entry)
./verify-graph cover derive
./verify-graph cover derive --refresh                  # replace derived entries after journeys are renamed

# 3. Re-check every claim against journey files + recorded evidence
./verify-graph cover audit
./verify-graph cover audit --require-all-covered       # stricter: blocked is not enough
```

The audit writes `controls/coverage.json` (machine) and `controls/COVERAGE.generated.md` (human table). Both are
generated; never edit them by hand. The ledger is `controls/ledger.json`.

Exit codes: `0` every control has exactly one honest conclusion and every covered claim proves itself; `1` a
control is unowned, a witness is unproven, a conclusion is duplicated, or a ledger entry is stale.

## Blocked and unowned (with a next step)

A `blocked` entry in `controls/ledger.json` carries `reason`, `attempts` and `next`; an unowned control is the same
todo without an entry yet, and is what makes the audit red. There are no unowned controls now; one durable
blocked example remains:

| control | page | why blocked | next |
| --- | --- | --- | --- |
| `退出 Graph` (menuitem) | tray | pressing it ends the process the remaining steps need, so the journey cannot leave a post-action state to read | press it last in a disposable surface run and let the process outside the journey assert the pid disappears |

Controls that used to be on this list are now covered by real journeys: `打开 Graph` is pressed in
`controls-tray` (surface lane) and the window is asserted visible afterwards; `移除` is pressed in
`controls-fleet`; fleet filters are pressed in `controls-fleet-filters`; resource categories are pressed in
`ctl-resources`; resource search and refresh are typed/pressed in F-12.

## Not-applicable (with a concrete reason)

- External targets: `打开 Magpie 配置`, `打开资源库文件夹`, `打开装配文件`, `附件` — they open the user's Finder or a
  native file picker, which the isolated run cannot observe and must not drive.
- Native window chrome: `Close`, `Minimize`, `Full Screen` — macOS window-manager buttons, not product behaviour;
  pressing them removes the window the remaining assertions need.
- Dynamic data: `编队 Agent verify` embeds the live project/agent name, so the card exists only while the fleet has
  that agent; the fleet page itself is covered by F-10 and the filter journey.
- Duplicate capture: `打开 扩展自动更新` (rail-settings) is the same switch F-14 already covers.

## How to add a witness

1. Find the exact accessible name, never guess:
   ```sh
   ./verify-graph ui text --run <run-id>
   ./verify-graph ui expect --run <run-id> --name 刷新编队 --role button
   ```
2. Add the action and a later assertion to that page's journey (or a dedicated `scenarios/controls-*.json`):
   ```json
   { "verb": "click", "name": "筛选 问题" },
   { "verb": "waitText", "text": "问题", "timeoutMs": 15000 }
   ```
   For a text field, type and read the value back:
   ```json
   { "verb": "type", "name": "查找供应商", "text": "magpie" },
   { "verb": "assertAccess", "name": "查找供应商", "value": "magpie" }
   ```
3. Run the journey for real; keep the evidence:
   ```sh
   ./verify-graph verify --journey controls-fleet
   ./verify-graph verify --journey controls-fleet --lane window   # menus, tray, popups, focus, keyboard
   ```
4. Derive and audit:
   ```sh
   ./verify-graph cover derive
   ./verify-graph cover audit
   ```
5. If the control cannot be reached, add a ledger entry instead of faking a witness:
   - `notApplicable[]` with a concrete reason (one-off, external system, unreachable, unstable locator);
   - `blocked[]` with `reason`, `attempts` and `next`.

Do not hard-code a witness for a dynamic/one-off control to raise the number. The audit reads the recorded run,
so a fake claim fails; an honest `blocked` entry with a next step is the correct answer.

## How the tooling is tested

`go test ./internal/controls ./cmd/verify-graph` covers, red-first:

- **manifest stability** — shuffled input and moved bounds keep the same ids and order; duplicate rows collapse;
- **classification rules** — covered / not-applicable / blocked, conflicting conclusions, empty reasons;
- **missing witness detection** — a control with no entry is `unknown` and fails; a click without a different
  visible result, a red run, and a headless tray claim all fail;
- **ledger hygiene** — stale witnesses/exclusions and a `covered` claim whose journey/step/evidence is missing fail;
- **documented commands** — `internal/skilldoc` and `acceptance` check that every `verify-graph <command>` named in
  the skill exists in `help`.

Cold-start guide with the full schema and gotchas: `skills/verify-graph/CONTROLS.md`.
