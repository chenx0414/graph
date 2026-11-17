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
