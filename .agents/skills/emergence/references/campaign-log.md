# Campaign log

Append one entry per emergence campaign. Keep entries factual and short. The
skill body owns the general rules; this file owns the evidence behind them.

## 2026-11-17 · Graph verification infrastructure

- Population: 12 agents, watch mode, 1 writer per file by emergent CONTRACT.
- Wish: build a critical-infrastructure verification capability for a native
  Go/macOS app, including UI interaction, delivered as one CLI + one skill.
- Converged: one Go CLI `verify-graph`, one verification skill, 16 feature
  files, 23 journeys. Headless 23/23 and real-window 23/23. The population
  invented its own `CONTRACT.md`, package ownership, feature map, evidence
  manifests, and cleanup command.
- Drifted: after green, agents kept adding runs and evidence; FINAL stayed stale
  while the report was updated. Runtime `.run/` reached 3.6 GB twice. A report
  cited evidence directories that no longer existed.
- Steering that worked: append the exact failing journey and its observed
  output to `task.md`; then "stop editing, write report and FINAL". The
  population fixed real paths, not the assertions.
- Steering that did not work alone: a FINAL marker; a polite "converge" without
  a hard stop. The captain had to stop the runner and validate claims.
- Harness lessons: provider timeouts stopped the scheduler; restarting the same
  command worked. A `.run/` directory inside the watched world produced
  `Not a regular file: .run/bin` and polluted state; a fresh
  `EMERGENCE_STATE_HOME` recovered it. Disk `ENOSPC` killed a run mid-write.
- Captain lesson: do not prescribe architecture or copy skill libraries into the
  world. State the outcome, acceptance, boundaries, and freedom. The population
  supplied the architecture.

## 2026-11-17 · Magpie provider models into Graph

- Population: 5 agents, watch mode; task asked to expose Magpie gateway
  `/v1/models` through Graph's model picker and route selected models through
  the gateway.
- Converged: agents invented a dynamic model catalog, provider-aware picker
  filtering, gateway credential binding, and 12 tests. `FINAL` said 12/12;
  app/backend tests and `graphcheck all` passed; the installed app returned
  251 model entries including Magpie providers.
- Did not stop: at 17:53 they wrote `FINAL`; at 17:54 all five were still
  `running: true`. They were re-running tests and generating build/verification
  artifacts (`dist/graphd`, `verification/**`), each of which woke the other
  four. `FINAL` is only a file; it is not a terminal event.
- Stop required: captain killed the tmux runner; coordinator went false and no
  pi processes remained. The `running` flags in status were stale until then.
- Task wording gap: `FINAL` was requested but the wish did not say "after
  FINAL, make no more edits and run no more commands; FINAL is your last
  action". Even that may not be enough without a hard stop; treat it as a
  boundary, not a scheduler feature.
