---
name: emergence
tags: multi-agent, orchestration, black-box, shared-workspace, pi, captain
description: >
  Run a population of homogeneous pi agents in one shared directory with the
  `emergence` CLI, steer the population by rewriting `task.md`, and converge on
  one reviewable product. Use when the work is large, exploratory, or has many
  independent workstreams: a wish-driven build, a parallel audit, a migration,
  infrastructure from scratch, or a "let 12 agents figure it out" request.
  Triggers on: "emergence", "涌现", "population of agents", "12 agents",
  "homogeneous agents", "shared workspace agents", "wish-driven", "black-box
  agents", "steer the swarm with task.md".
---

# Emergence

`emergence` runs N identical pi agents against one shared directory. Every agent
has the same system prompt, the same four tools (`read`, `write`, `edit`,
`bash`), and the same model. There are no roles, no task assignment, no
manager. An agent wakes when the shared world contains a file version it has
not yet perceived; it acts, then sleeps.

You are not the architect. You are the **captain**: write the wish, read the
output, adjust the wish, decide when the result is done, and commit it.

## When to use it

Use emergence when three things are true:

1. The outcome can be judged from the shared directory (code, docs, tests,
   evidence), not from a live conversation.
2. The work can fan out into independent files or discoveries.
3. You can afford a population that may invent its own coordination.

Do not use it for a single known edit, a task that needs one accountable owner,
or anything where "more agents" only means "more duplicate work".

## The loop

1. Write a wish.
2. Launch the population.
3. Read what landed. Do not read the agents' thoughts.
4. When the output drifts, rewrite `task.md`. Do not describe the implementation.
5. When the acceptance line is met, stop the population and take over as captain.

## 1. Write the wish

`task.md` is the steering wheel. It is read by every agent and is the only
channel you need. Write the **desired outcome**, not a plan.

Include, in this order:

- **Desire**: what the user gets, in their language.
- **Acceptance**: how a cold reviewer proves it. Commands, artifacts, evidence.
- **Boundaries**: where they may write, what they must not touch, what must not
  be committed.
- **Freedom**: explicitly say they choose the architecture, language, division
  of labour, and order. That permission is what makes the population
  self-organize instead of waiting for you.
- **Stop condition**: what "done" looks like, and the marker or report to leave.

A compact template:

```md
# Wish

I want <user-visible outcome> in `<directory>`.

## Acceptance

- <one command> proves <one outcome>.
- <evidence> exists and can be rechecked.
- <coverage / quality bar>.
- A cold agent can use it from the docs alone.

## Boundaries

- Only write `<directory>`.
- Do not commit. The captain commits.
- Do not touch <user state, running services, credentials>.
- Do not fake proof by weakening assertions.

## Freedom

Choose the architecture, language, naming, file layout, and division of labour.
Work in parallel if useful, but converge on one coherent result.

## Done

Write `<REPORT>` and `<FINAL>` when <acceptance> is green. No FINAL before green.
```

Avoid in the wish:

- a pre-baked architecture or CLI command surface;
- file ownership tables or phase gates you invented;
- "write proposals first, wait for me";
- copied reference skill directories. The agents can read the repo or fetch what
  they need. Put the outcome in the wish, not a syllabus.

If the task is genuinely huge, phase it by **outcome**, not by your org chart:
first wish produces a working slice; a later `task.md` rewrite extends it.

## 2. Launch

Run from the emergence checkout, or use the linked `emergence` binary. Keep the
log and all run scratch outside the watched workspace.

```sh
mkdir -p /tmp/emergence-logs

tmux new-session -d -s emerge-<name> \
  -c /path/to/emergence \
  "emergence run \
     --workspace /path/to/shared-dir \
     --agents 12 \
     --provider <provider> --model <model> \
     --thinking medium \
     2>&1 | tee -a /tmp/emergence-logs/<name>.log"
```

- `--agents N`: population size. All eligible agents run concurrently.
- `--provider` + `--model`: must be a pair from `emergence models`.
- `--thinking`: `off|minimal|low|medium|high|xhigh`.
- No `--once` while you are actively steering; it exits when no agent has
  unperceived differences. **Idle is not done.**
- Log outside the workspace. A log written into the world is one more
  file-difference and can feed the population noise.

State lives outside the workspace by default under
`~/.local/state/pi-emergence/`. If state is corrupted or you want a clean
population, point `EMERGENCE_STATE_HOME` at a new directory rather than
hand-editing `state.json`.

Useful probes:

```sh
emergence status --workspace /path/to/shared-dir
tmux has-session -t emerge-<name> && echo running
tail -f /tmp/emergence-logs/<name>.log
```

`status` reports `coordinator` (is a live runner holding the lock) and each
agent's `running` state.

## 3. Read the room

Inspect only the shared world:

- new and changed files;
- the report and evidence the population left;
- `git status` and the repo's own gates.

Do not read pi session JSONL unless diagnosing a stuck run. The product is in
the files.

What self-organization looks like when it is healthy: a `CONTRACT.md`, a file
ownership list, a queue, tests, evidence directories, a report. It may invent
these without being told. Read them to understand the current shape; do not
reward ceremony that does not produce acceptance.

## 4. Steer with `task.md`

When output drifts, change the wish. Never patch their code or dictate their
architecture from the captain seat unless the user explicitly asks you to
implement.

Good steering edits:

- add the exact failing acceptance case and its observed output;
- name the evidence path that no longer exists;
- raise or lower the quality bar;
- narrow scope: "stop expanding, make the existing acceptance green";
- force convergence: "stop editing; write the report and FINAL now."

Bad steering edits:

- a design document;
- a file-by-file work order;
- "use library X" when the outcome does not require it;
- a new phase that only produces more proposals.

Every rewrite wakes agents whose only dependency is `task.md`. They may still be
mid-run; changes arrive as steering after their current model turn.

## 5. Converge

The population will usually keep polishing. **Idle is not done; a FINAL file is
also not proof.** Before you stop:

1. Run the acceptance yourself from a clean shell.
2. Recompute evidence manifests or hashes.
3. Check every path the report cites actually exists.
4. Check the repo gates and `git status`.
5. Check resource use: runtime directories can grow to gigabytes.

Then stop the runner. Ctrl-C in the tmux session is the gentle stop; killing the
tmux session also works. Confirm no coordinator remains:

```sh
emergence status --workspace /path/to/shared-dir
```

`coordinator: true` after stopping usually means an orphaned runner or a stale
lock. Find the process; do not delete the lock and assume safety.

Clean up:

- kill only daemons/windows the run recorded (the output may provide a cleanup
  command; use it);
- delete runtime state (`.run/`, scratch homes), keep the evidence the report
  cites;
- stop processes by recorded PID/command, never by broad process name;
- confirm the user's own services are still healthy.

Only then commit, and only if the user wants the work committed.

## Time box

Set a stop condition before launch. Examples:

- "Stop when acceptance is green; do not add journeys."
- "Stop when the report and FINAL are written; no new test runs after that."
- "If acceptance is still red after 45 minutes, stop and report the blocker."

The captain enforces the box. The population will not.

## Pitfalls

- **Runtime dirs inside the workspace.** A `.run/` directory with changing
  daemons, tokens, and sqlite files becomes a flood of file-differences. It can
  also make the harness choke on directories. Keep transient state outside the
  world; only copy final evidence in.
- **Disk.** Twelve agents running UI tests can create several GB per hour.
  Watch free space; prune old runs and evidence. A full disk stops the runner
  with `ENOSPC` and can leave a corrupt state write.
- **Provider weather.** Model timeouts stop the scheduler. Read the final JSON,
  check whether it was a provider/network error, then restart the same command.
  If repeated, use another authenticated provider/model pair, not a different
  prompt architecture.
- **Corrupt state.** If status or startup throws, start a fresh world with a new
  `EMERGENCE_STATE_HOME`; do not hand-edit `state.json`.
- **The report lies by drifting.** Agents may cite evidence they deleted or a
  run they replaced. Validate every cited run directory and manifest.
- **Local escalation.** Agents may start real daemons, windows, or launchd
  services. Require isolation in the wish; verify the user's instance before
  and after.
- **Premature FINAL.** Treat FINAL as a claim. Run the acceptance command.
- **Do not use `--once` to "wait for done".** It exits at quiescence, which
  only means no agent currently perceives a changed file.

## Keep this skill current

This skill improves by campaign, not by theory. After each emergence run:

1. Read `references/campaign-log.md`.
2. Run the campaign.
3. Append one entry: what converged, what drifted, which task.md wording
   changed the behaviour, what resource or harness failure appeared.
4. If a lesson generalizes, edit the smallest section above. Move one-off
   details to the campaign log; keep the main steps lean.

Do not add rules for failures you have not observed. Do not keep duplicated
advice in both the steps and the log. If this file grows past the point where a
cold agent can read it in one pass, move examples to `references/` and leave a
pointer.

## Quick reference

```sh
# model pairs
emergence models

# watch population
emergence run --workspace DIR --agents 12 \
  --provider PROVIDER --model MODEL --thinking medium

# one-off: exit at quiescence (not completion)
emergence run --once --quiet --workspace DIR --task "..."

# inspect / direct
emergence status --workspace DIR
cat DIR/task.md
```

The captain's loop in one line: **wish, launch, read, re-wish, verify, stop,
commit.**
