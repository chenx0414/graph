# Dead test-only artifact provenance subsystem

Read all 229 lines of src/core/artifact-provenance.ts and all 10 declarations of tests/m8/artifact-provenance.test.ts. Repository-wide references show sole runtime import is that test; kernel_artifacts and kernel_reviews table names occur only in the disconnected module. Historical phase-6 addition 9a5de50 was never integrated into the actual execution/publication/acceptance path. Live-loadability historical comment names it but discovers modules dynamically, so has no import requirement.

Actual runtime owners are ArtifactWorkspace (artifacts, metadata.code/subgraphPath, immutable content), NodeExecutor/settleDeliverable, and graphAcceptance (actual native execution/provider-call identities, published graph.review@1 bytes, exact current integration commit). Removal cannot remove a user publication or review because no public path executes the disconnected class or creates its tables. Existing tables in users' SQLite databases are untouched.

All 10 declarations marked D for proof of unreachable parallel implementation; underlying independent contracts retained at their real owners:

| Declarations | Real proof |
| --- | --- |
| A1 repository/commit/worktree and nested stable path; top-level null path | Native graph artifact publication and subgraph/workcopy workflows; public metadata records actual execution workspace and commit |
| A2 immutable old commit/digest; duplicate version overwrite refused | Actual native immutable artifacts retained in graph-artifact-owner; console/context-model frozen literal version read; no public overwrite API |
| A3/A4/A5 stale review cannot pass / exact current passes / stale publication remains | graph-final-acceptance actual native reviewer first publishes baseline review, public acceptance reports stale and complete blocks; later real review passes; both published versions remain (count 2) |
| A6 text report needs no commit | console native notes publication; graph-artifact-owner native text versions |
| A7 provenance has no acceptance property | Private helper result shape only. Real final acceptance requires host checks, actual independent review and human approval before actual exact Git delivery |
| Empty commit/repository private constructor guards | Disconnected value builder only; production code publication resolves a valid actual repository/commit and verifies committed bytes, independent rejection proof retained in m8/node-deliverable |

This retires test-only implementation and its parallel schema instead of adding public seams to reach it. Source/table reader searches and above full owner reads are evidence; sibling test validation and independent preservation review remain required. No production behavior repair claimed.

Root batch22: graph-artifact-owner, graph-final-acceptance and live-loadability siblings all green; entire requested 15-owner batch 72 cases green. Test-only provenance removal has live import and real independent publication/acceptance proof; no production call path depended on removed module. Independent preservation review remains required before final campaign completion.

## Obsolete implicit handoff tracing seam

Repository-wide source callers of ArtifactWorkspace.recordReference(s): only singular wrapper calling plural method; no production user invokes either. Sole artifact-workspace helper declaration fabricated an artifact.referenced trace by manually calling wrapper. ADR0030 and architecture explicitly remove inferred predecessor handoffs; native inputs do not claim an artifact was read, while actual artifact_read separately records artifact.accessed. Remove both dead methods and sole fabricated trace test. No event/schema migration or data deletion. Remaining eight artifact-workspace helper contracts retained for genuine native publication migration (tags, slug, immutable CAS, path/symlink, guidance, text, project isolation, retirement, 101 versions); no blanket delete.
