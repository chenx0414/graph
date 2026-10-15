# Scope preservation independent review 35

Read-only review during parent's active six-file candidate/sibling run. No checkout edits or tests invoked. Full new E2E file (all3 declarations), full sole remaining old console/agent-skills file, full agent-skills owner and resident-launcher, current focused diffs and relevant native graph/session/capability assembly read. Related sources previously read in lane33/34. Current file hashes at review below; parent owns authoritative test outcomes.

## Verdict

No actionable correctness/security regression found in the focused scope fix. The change restores an existing declared skill-source contract at the production owner. Conditional on parent's passing post-fix candidate/siblings and intended before-fix/control evidence, the **sole old `the scope loads the Agent folder, the global folders and the project folders` declaration may retire**. It protects scope union and absent-folder omission, both now exercised through actual CLI/native worker/model request and actual public runtime facts.

## Correct source of each root

`task-runtime.projectRootFor(store)` selects p.root by tasks.project_id → projects.id. It is the bound configured project's root; it is not supplied in model tool arguments, selected from another project, or inferred from worker process cwd. This function already owns kernelGraphLane.workspaceFor. New nodeSessionOptions.projectRoot simply carries that same root through openAgentContextAssembly.skillProjectRoot to CapabilityBundle's existing agentSkills scope loader. Original capability-bundle comment expressly says bound project roots are included for every Agent; old helper test itself deliberately separated cwd/projectRoot.

Execution working root remains nodeLocation: frozen graph node definition chooses project or actual admitted Git worktree; requested workspace.path canonicalized through realpath and checked inside chosen base. New patch does not change selection, write grant or containment check. A prepared worktree therefore remains working cwd (and can contribute its own local skills), while bound original project contributes only .pi/skills and .agents/skills. Using original projectRoot for this additional source matches existing domain contract; it should not be replaced by integration/worktree root because that would again lose original bound-project scope. New E2E covers distinct subdirectory `project/work`; it does not independently test worktree-variant union, so final report must not claim actual Git worktree scope was executed by this case.

## Permission extent

`nativeSkillDirs` enumerates only existing directories: SDK-configured Pi global skills, HOME/.agents/skills and .pi/skills + .agents/skills for actual cwd/bound project. It deduplicates strings and does not grant arbitrary ancestors or project root as a whole. Host discovery is necessary: resident-launcher intentionally strips unrelated parent environment, so PI_CODING_AGENT_DIR cannot be rediscovered reliably inside sandbox worker. Passing host-resolved paths is consistent with existing main skill behavior.

New config.skillPaths are passed to existing resident-launcher as readPaths (realpath resolved), and for full-access protected-read exceptions only; writePaths remain workspace/state/explicit operation writes. No grant to entire HOME or project root and no new network/command/write authority. Existing agent-skills discovery follows user-controlled skill-folder contents/symlinks by native SDK semantics; this patch does not newly invent that trust model. Config paths may grant read access to content within these skill folders beyond SKILL.md as native skills can refer to resources; that matches existing native folder contract, not an unexplained broader tree grant.

Earlier pi-instance fix combining skillFolder + skillPaths is necessary: otherwise own folder silently wins and discards explicit host paths. New graph config merges operation-bound paths + host native folder discovery, while SDK explicit own skillFolder still ordered first. Metadata loader and native loader therefore see the same union. No fake metadata added to satisfy test; actual CapabilityBundle facts and actual SDK prompt both rebuilt from real folders.

## Preservation mapping

Old sole scope test creates own/globalPi/globalAgents/cwdPi/cwdAgents/anotherProjectAgents, calls agentSkills with cwd != projectRoot and asserts exact six names. Its absent-folder subcase asserts own-only. New third case populated row creates own/globalPi/globalAgents/boundProjectPi/boundProjectAgents/cwdPi/cwdAgents, obtains real actual CLI graph ID from native main graph_create return, native graph_send then real worker HTTP response, validates current environment cwd != bound project, public recorded capability exact names and one actual native available_skills block containing each exact name/description/location. It is stronger than old six-name helper check; bound-project Pi is additional independent coverage.

Absent row independently launches isolated CLI with absent global/project/cwd dirs, actual own-only skill; compares exact actual metadata and native block names, and lstat verifies all six nonexistent directories. It cannot pass merely because both loaders returned empty, since own skill is positive anchor and block count must be1. Distinct actual temporary projects/HOME/PI_CODING_AGENT_DIR prevent accidental operator skill contamination. Existing first/second E2E cases still preserve catalog duplicate identity/disabled semantics and owned-link retarget/removal without clobbering handwritten/unowned entries.

Exact XML expected locations are fixture-independent known paths; native metadata and prompt are each compared against fixture literals, not against each other. Soft assertions report both owner metadata and SDK loss independently; expect.soft still fails final Vitest case. Actual worker success + one provider request avoids passing on never-dispatched graph.

## Verification constraints and minor observations

Parent reports before-fix run lost bound-project metadata and Pi-global/bound-project SDK prompt; this review did not independently run it. Parent must retain separate owner mutations/control if needed to attribute both lost wires and restore sources byte-for-byte, plus passing candidate after restoration before retirement.

Optional housekeeping only: workspaceFor(graphId) is called twice in the spread expression and again for config skill paths; production resolver is pure synchronous DB lookup and graph project binding is stable. A local `projectRoot` constant would read clearer but is not required and should not trigger another edit/test cycle. New optional projectRoot API has a real production caller, so it is not a test-only seam.

No worktree scope execution or native model explicit SKILL.md body-read is asserted by third case: it proves native skill listing/loading and source paths. Source inspection confirms sandbox read grants; do not overstate runtime proof. These are not lost contracts in old helper sole, so they do not block its retirement.

## Reviewed hashes

- `src/runtime/kernel-node-host.ts`: `06677f6d8ff2abf3f1d71e9f893f3115a3443ea21975fc0c0ec0cd1c5cbaa180`
- `src/runtime/kernel-graph-lane.ts`: `6623029e3d53674d8657be0b1b6fb77af137626d9a54c0006c3feb4501bcd6d2`
- `src/runtime/pi-instance.ts`: `f98690ef5b11bcf14f8f40cddcf850fff437eb8b80911a1bc5ae99a3d88b3f53`
- `tests/e2e/agent-skills.test.ts`: `4de0eace3d4eddb692a3b2deb08f8dd96bcde3f6ed02608169afd0be51ffec56`
- `tests/console/agent-skills.test.ts`: `377fd0c9987673e38a2b02ed0ddcb4c1a41f87c50e6cd5e3ab4c1f33a3f3e212`
