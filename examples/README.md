# Examples

These source examples demonstrate Graph's runtime contracts. `m7-acceptance.ts` uses the providers explicitly configured by the user; its automated regression tests use local HTTP providers and disposable repositories.

- `m1-demo.ts`: persistent task state, an Agent action, a program check, evidence, and delivery across two Node processes.
- `m7-acceptance.ts`: the native M7 acceptance entry. One conversation owns a separately confirmed graph; main starts named inputs and requests completion. Version-2 `run.json` resumes the same identities; legacy runs require a fresh directory. Exact draft versions and current commit-bound human questions must be confirmed explicitly.
- `m7-contract.ts`: graph-to-delivery contract checks.

Run examples from the repository root, for example:

```sh
node --run demo:m1
```

Examples are part of the source documentation referenced by the Agent system prompt. They are not copied into `~/.graph`.

For M7, configure `GRAPH_M7_MODEL_BASE_URL`, `GRAPH_M7_MODEL_API_KEY`, `GRAPH_M7_MODEL_ID` and a distinct `GRAPH_M7_REVIEW_MODEL_ID`, then run `node --run accept:m7`. Follow the printed confirmation command with the same `GRAPH_M7_WORKDIR`. No root is started implicitly. Unknown provider usage requires actual usage reconciliation through `graph_control`; the old proof-only waiver and program-node environment options are retired. Exit 0 means complete, 1 means waiting, and 2 means failure.
