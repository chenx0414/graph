# Durable migration: legacy execution retirement

> 历史实施与验收记录：保留当时的实现和证据，不代表当前进程模型或任务状态。当前 Go + durable 基线见 [2026-10-20 整合说明](../planning/baseline-cleanup-2026-10-20.md)与 [ADR 0032](../adr/0032-go-backend-shared-durable-host.md)。

This audit covers the execution owner change approved in ADR 0031. It does not certify recovery, production cutover, or desktop acceptance. The complete migration must pass the repository check and the actual app flow before delivery.

## Production owner

The default main and node transports use the same runtime-owned durable Harness. The node lane no longer constructs a ResidentHost; the main adapter requires a supplied transport. The removed modules are pi-instance, pi-process, pi-worker, resident-host, resident-launcher, resident-worker, resident-worker-entry and worker-requests. They contained the old Agent session loop or its private IPC protocol. The two old transport factories are removed from agent-session; its request, inspect and usage contracts remain shared by the durable bridge.

pi-adapter remains because it owns Graph conversations, capability composition, provider admission, credential scheduling, auxiliary suggestions and sediment. Pure v1.1 SDK tool definitions, extension loading and historical session parsing also remain. Graph has no direct pi-agent-core import; controlled provider streaming has its own structural type. The package can retain agent-core transitively for the coding-agent standalone loader.

## Test ownership and retirement

The old tests were introduced for the previous resident architecture (latest shared lifecycle change: 59fd825). Their production callers were the removed resident/session modules; the following mapping distinguishes obsolete execution shape from retained behavior.

| Removed case or file | Contract and stronger owner | Reason / deletion unlocked |
| --- | --- | --- |
| m8/spike-resident-worker: stable PID over three turns | Persistent identity and history: durable/main, m0/pi-process and public graph completion | A process per Agent is not the durable execution contract; removes spike child harness. |
| m8/spike-config-rebind: PID and new JSONL session on bundle change | Public conversation capability rebind and independent reviewer/Matt tests retain transcript and exact bindings | Durable conversations retain their identity across idle configuration changes. |
| m8/resident-host H1–H5 and mid-turn child exit | Durable actual main/node crash recovery; m0/agent-session-contract close/abort/length; m0/pi-instance soft stop | Old child-manager restart/PID/wire tests cannot prove the new durable checkpoint protocol. Actual SIGKILL recovery remains a separate required owner. |
| m8/resident-host extension OS grants | durable/main real published MCP gateway; m0/pi-process plugin grants; m0/restricted-process actual OS denied writes | Retained actual plugin/tool effects replace a second Agent worker. |
| m8/resident-transport X1–X3, owner stream closure | Provider authorization and unsupported transports: controlled-provider tests, m0/pi-process credential isolation and m0/agent-session-contract abort | Spike fallback credentials and owner stdin packets are removed with the old wire protocol. |
| console/mcp-adapter-wiring | durable/main uses actual published MCP package and a local MCP server, persists actual tool output and checks frozen declarations | Old tests copied request fields to a worker config; stronger runtime proof detects a dropped bound server without retaining a serialization-only production export. |
| m8/tool-channel | Public graph completion: malformed submit is refused, corrected output reaches receiver exactly once, undeclared tool remains unavailable | Fake worker receipts are replaced by actual TaskRuntime submission/delivery. |
| Old m0/pi-instance v2/v3 JSONL rebind, fresh JSONL identity, private fork monkeypatch, transient Agent retry | Passive legacy import, public capability rebind, durable crash recovery and controlled provider admission/retry owners | New runtime does not create or reopen legacy Agent sessions. Historical bytes are imported passively and remain archived. |

The m0/pi-instance file retains actual durable tool allowlisting, soft stop, large result handling across reopen and telemetry. m0/pi-calls retains real provider/gate usage, pauses, retries, unknown costs, compaction and argument repair. m0/pi-process retains actual isolated prompts, payloads, plugin loading/allowlisting and credential denial. m0/agent-session-contract retains meaningful lifecycle, compaction, interruption and output-limit behavior with one durable transport rather than two obsolete transports.

The legacy main import test now seeds literal historical JSONL and old visible messages/accounting; it never runs an old Agent loop to manufacture the migration fixture. Startup imports it before any model call, then actual provider requests prove branch selection, Unicode summary, tool context and a subsequent reopened turn.

## Regressions found during the port

Retained tests failed against the first durable bridge: idle/soft stop permanently blocked subsequent turns; repeated large tool results lost Graph's persisted occurrence counts and were truncated by Harness before the first two full views; interrupt returned before its explicit replacement input finished; undeclared plugin tools leaked into model declarations; argument repair was not forwarded. The production owners now reset stop state for a new prompt, apply Graph's persisted result hook and output ceilings, await the explicit new interruption submission, filter frozen plugin declarations and forward prepareArguments. Provider/native dispatch settlement remains conditional on actual admission.

The executed retirement audit records 274 files / 1883 tests before removal and 268 files / 1847 tests afterward: six obsolete files and 36 cases retired. Integrated recovery owners subsequently add two files; additional fresh-resource and read-boundary cases retain behavior. The final integrated suite must pass before its deliberate reduction is recorded through GRAPH_UPDATE_BASELINE=1. Two-axis review findings are resolved; the whole check and desktop cutover remain required. Focused proof and the detailed executed case comparison are retained in temporary logs under /tmp/graph-durable-retirement-*. No tests are skipped and no old Agent execution is retained for test use.
