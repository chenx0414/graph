# Examples

These source examples demonstrate Graph's runtime contracts. They are driven by the Go backend: the repository launcher (`src/server/cli.ts`) starts the real `graphd` process, and everything below talks to it over its public HTTP surface.

- `graphs/*.json`: native pipeline, fan-out, nested routing and external-main worker definitions. Bind the declared recipe/model IDs before graph_create; main starts public job and requests completion. The node --version operation demonstrates wiring only; replace it and declare acceptance for project verification. Fan-out joins latch once and need explicit reopening for another batch.
- `m7-contract.ts`: graph-to-delivery contract checks.

Run examples from the repository root.

Examples are part of the source documentation referenced by the Agent system prompt. They are not copied into `~/.graph`.

`m1-demo.ts` and `m7-acceptance.ts` were retired with the TypeScript backend (2026-10-23): both opened the TypeScript runtime in-process to build and drive a graph. The contracts they demonstrated are proved by the Go E2E suite instead — a native graph survives a daemon restart (`tests/e2e/go-startup.test.ts`), a confirmed graph really runs and a submission really travels along the edge (`tests/e2e/go-graph-confirmation.test.ts`), and a worker really writes only its own work copy (`tests/e2e/go-node-lane.test.ts`).
