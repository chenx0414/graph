> 历史记录：首次 Go 逐文件移植时的约束与差异，保留原文供追溯。当前运行边界以 [ADR 0032](../../adr/0032-go-backend-shared-durable-host.md) 和 [架构](../../architecture.md)为准；其中本地探针日志未发布到仓库。

# Deviation log — TypeScript → Go port

Companion to `RULEBOOK.md`. The rulebook is the contract; this file records where the Go
port could not be byte-identical to the TypeScript, why, and what the difference costs.
`RULEBOOK.md` itself is unchanged.

Markers in the Go source use the exact spellings `TODO(port):`, `PERF(port):`, `BUG(port):`.
Every deviation below is also marked in the code it belongs to, except where the code is a
faithful port and only the ordering of a JSON object differs.

## Accepted by the rulebook

| ID | Deviation | Why it is acceptable |
|---|---|---|
| DEV-A1 | `encoding/json` sorts the keys of a map; TypeScript keeps the insertion order of an object literal. | RULEBOOK §1 already states it. Structs keep the field order of the TypeScript object, so every response the UI or an E2E test reads field by field is unaffected. RULEBOOK §6 pins only the SSE frame order (`cursor, taskId, type, data, timestamp`) and the startup object; both are structs and keep the exact order. No E2E assertion compares a response body verbatim. |
| DEV-A2 | One Go package instead of five directories. | RULEBOOK DEV-002. File boundaries stay one-to-one with `src/<area>/<name>.ts`. |
| DEV-A3 | No `PORT STATUS` trailers per file. | RULEBOOK DEV-001. |

## Deviations that needed a decision

| ID | Date | Deviation | Consequence | Where |
|---|---|---|---|---|
| DEV-003 | 2026-10-20 | `backend/internal/graph/http_client.go` — a file RULEBOOK §0 marks as shared and unedited — gained the environment proxy and `NODE_EXTRA_CA_CERTS` support. | The TypeScript daemon was started as `node --use-env-proxy`, so `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and the extra CA bundle were the Node process' behaviour. The Go binary replaces that process, so it has to carry the same semantics itself; without them every usage-subscription provider answered `connected: 0` instead of `6`. The file is edited in place, not forked, so every caller keeps one client. | `backend/internal/graph/http_client.go` |
| DEV-004 | 2026-10-20 | The store serializes transactions with a mutex and reuses the outer transaction for a nested one. | The TypeScript runtime is single-threaded with synchronous SQLite, so a nested transaction joins the outer one. The Go port runs the worker protocol on its own goroutine while the drive loop is active; without the lock SQLite answers `cannot start a transaction within a transaction`. The lock restores the single-writer behaviour and keeps the asynchronous event/tool interleaving the TypeScript code has. | `backend/internal/graph/core_store.go` |
| DEV-005 | 2026-10-20 | The Pi SDK's transcript semantics are reimplemented in Go: `normalizeContext`, the system-message fold, the section rendering and the tool replay. | RULEBOOK §0 does not translate the SDK, and §7 makes the provider HTTP API the boundary. The request body the provider receives is built by the port, so the rules that shape that body live at the boundary too. Without them the request carried an empty system message and no tool declarations. | `backend/internal/graph/runtime_controlled_openai.go` |
| DEV-006 | 2026-10-20 | The worker channel decodes JSON with a key-order-preserving decoder for `sections` objects. | A Go map has no insertion order, and the system prompt sections are ordered (`preamble` first, then the rest). A plain map would reorder the prompt the model receives. The decoder keeps the order of the transcript the worker sent. A section set that arrives as a plain map — a path only the in-process Go code builds — is read by name instead, marked `TODO(port):`. | `backend/internal/graph/runtime_pi_worker.go`, `backend/internal/graph/runtime_controlled_openai.go` |
| DEV-007 | 2026-10-20 | The seatbelt profile of a restricted command is built by the host instead of by the third-party sandbox runtime. | The TypeScript implementation asks the sandbox runtime for a wrapper and decodes its POSIX-quoted form. The Go port builds the deny-default profile itself and launches `/usr/bin/sandbox-exec` directly, because the sandbox runtime is a Node package. The permission list is the equivalent a toolchain needs, not the runtime's own list. | `backend/internal/graph/runtime_restricted_process.go` (`sandboxBaseProfile`) |
| DEV-008 | 2026-10-20 | A check that asks for a loopback listener is refused instead of being handed the bound socket. | Node's IPC protocol carries a socket descriptor as a native handle; the Go host cannot mint one. The host binds the requested port and refuses the adoption request with `EPERM`, so the check never holds an accepting descriptor. | `backend/internal/graph/runtime_restricted_process.go` (`handleIpcLine`) |
| DEV-012 | 2026-10-20 | The provider browser-authorization routes answer `400 invalid_config` ("浏览器授权需要桌面安全存储通道") instead of running the OAuth flow. | The flow is the Pi SDK's OAuth client, and RULEBOOK §7 keeps the Pi SDK out of the port. The desktop shell owns the secure storage channel and the console learns that the channel is unavailable. The three routes keep their paths and methods. | `backend/internal/graph/server_app.go` (`serveProviderLogin`, `serveProviderLoginStatus`, `serveProviderLoginCancel`, `serveProviderDisconnect`) |
| DEV-018 | 2026-10-20 | A provider turn that reports no usage is costed with an estimate instead of being treated as unknown usage. | The Pi SDK estimates the tokens of a turn that carries no usage; RULEBOOK §0 keeps the SDK out of the port, so the request profiler's byte heuristic is used and the result is marked `estimated`. The TypeScript server treats such a turn as unknown usage and fails the node with "Execution ended after submit with unknown usage", so a provider that omits usage stops a graph there and does not stop it here. The estimate is marked `TODO(port):` in the source. | `backend/internal/graph/runtime_controlled_openai.go` (`estimateUsage`) |

## Behaviour that stayed faithful but needed a host-side change

| ID | Date | Change | Why |
|---|---|---|---|
| DEV-009 | 2026-10-20 | The Go daemon starts the Pi worker with the `node` binary: `GRAPH_APP_NODE`, else the `node` on `PATH`, else the own executable. | The TypeScript daemon spawned `node src/runtime/pi-worker.ts`. The Go daemon has to name the same runtime; `os.Executable()` returns the Go binary and made every worker fail to start. The Electron branch of the TypeScript daemon is not reachable from the Go process and stays marked `TODO(port):`. | `backend/internal/graph/runtime_workspace_command.go` |
| DEV-010 | 2026-10-20 | The host waits for the worker's `ready` handshake before it sends a prompt. | The worker announces its session identity before it accepts a prompt. Without the handshake the instance manifest recorded an empty session id and a failed turn was swallowed as an empty reply. | `backend/internal/graph/runtime_pi_process.go`, `backend/internal/graph/runtime_worker_requests.go` |
| DEV-011 | 2026-10-20 | `PI_CODING_AGENT_DIR` is honoured when the global Pi skills folder is resolved. | The Pi SDK's `getAgentDir()` reads that variable first; the Go port resolved `~/.pi/agent` only, so the global skill scope was invisible. | `backend/internal/graph/runtime_agent_skills.go` |

## Public surface that was missing and is now implemented

These five routes of RULEBOOK §6 answered `400 {"code":"internal","message":"… does not expose … yet"}`
because the runtime method behind them was never written, even though the domain code
already existed. They are now implemented on the runtime and the routes answer the real
payload.

| Route | Runtime method | What it answers |
|---|---|---|
| `GET /api/catalog/definitions/:definitionId` | `TaskRuntime.Talent` | The definition detail plus the per-metric experience statistics. |
| `POST /api/tasks/:taskId/graph/control` | `TaskRuntime.ControlGraph` | One graph execution control. The route now passes `nodeId`, `moduleId` and `seq` through unchanged; before, `moduleId` was written into a task-control field and `seq` into a token field. |
| `GET /api/agent-context` | `TaskRuntime.AgentContextPreview` | The prompt library view of the next main turn: the prompts, the disabled tools, the docs root, the definition version, the tool surface, the capabilities and the prompt the last send carried. |
| `GET /api/conversations/:conversationId/artifacts` | `TaskRuntime.ListConversationArtifacts` | The artifacts of every task of the conversation, deduplicated by artifact and version. |
| `GET /api/catalog/pi-extension-updates`, `POST /api/catalog/pi-extensions/:id/:version/update` | `TaskRuntime.PiExtensionUpdates`, `TaskRuntime.UpdatePiExtension` | The Pi extension sources that have a newer version, and the install or upgrade of one source. |

A sweep of all 101 routes of RULEBOOK §6 against the real daemon is in
`migration/logs/route-sweep.log`: every route is registered (no `404`), and every answer is a
domain error (`invalid_input`, `invalid_config`, `forbidden`, `not_found`) rather than an
unimplemented one. The sweep is `migration/route-sweep.sh`; it probes `GET /assets/*` with a
real file under `<webDir>/assets`, so the static route is read for content it can serve and
not for a file that happens to be missing.

One porting bug was found by that sweep: `capabilityReplaceInvalid` treated its allowed set
as literal characters, so `"A-Za-z0-9_-"` matched none of the lowercase letters and every
declared tool name was mangled into underscores. The set is a character class now, with
ranges.

## Bugs the port had, found by the m8 acceptance run

`tests/m8/integration.test.ts` drives the whole productized flow against the Go process:
a draft, a confirmation, the wake that names the confirmed graph, the dispatch of its
inputs, two worker nodes that submit their outputs, and the host-command module that
checks them. It passed on the TypeScript server and failed on the Go one. The five
defects below are what stood between the two.

| ID | Date | Defect | What it did | Fix |
|---|---|---|---|---|
| DEV-013 | 2026-10-20 | The wake ledger stored no data for four wake kinds. | `WakeIntent` carries a fact's data plus a `HasData` flag, and four call sites passed the data without the flag. The row's data column was SQL NULL, so the master was woken with "Graph undefined is ready and awaits explicit input": it could not read the graph it was told to inspect, and the confirmed graph never ran. | The four call sites set the flag, and the ledger stores the data whenever the caller passed one. |
| DEV-014 | 2026-10-20 | The provider request rendered an assistant message as a user message. | Every message that was not a system message or a tool result became a `user` message, so the model's own tool call came back to it as an empty user turn. The model did not recognize the call it had made and repeated it forever, and a tool result arrived without the assistant turn that asked for it. | The assistant message keeps its role, its text is the content and its tool calls are OpenAI tool calls, the way the SDK renders them. |
| DEV-015 | 2026-10-20 | The instruction message always used the `system` role. | The SDK sends `developer` to a reasoning model on a provider that accepts that role, and `system` to the providers that do not. The port sent `system` to everyone. | The provider's answer is detected from its name and its base URL, the way the SDK detects it. |
| DEV-016 | 2026-10-20 | A module published its output as a Go struct. | The protocol validator reads a JSON object, and a Go struct is not one, so every `workspace.command` module failed with "check.result: must be object" even though the command itself had passed. | The published value is the plain JSON object, the same shape the settled operation is read back as. |
| DEV-017 | 2026-10-20 | A module whose output validated was still reported as an unknown output. | The check for an unknown output and the protocol validation shared one default value, so a *passing* validation kept the "Unknown output" text and failed the module. | The two are separate checks now, the way the TypeScript has them. |

`tests/e2e/go-wake-notification.test.ts` locks the facts the wake depends on against the
real Go process: the wake names the graph, the model reads its own tool call back as an
assistant turn, the two worker nodes submit, the host-command module checks them, and
every node of the confirmed graph ends succeeded. Its provider reports the usage of
every turn and dispatches the graph input once, so the assertions are about the daemon
and not about how a test provider behaves.

## Bugs the port had, found by the deployment run

The port was run as the backend of the packaged desktop APP, against the user's own
configuration, credentials and task history, and against the real provider. The E2E
suite had passed all of this before, because it drives the daemon through its own
harness and its own provider. Five defects stood between the two, and each of them
stopped a real master turn.

| ID | Date | Defect | What it did | Fix |
|---|---|---|---|---|
| DEV-019 | 2026-10-20 | A restricted process never received its request on stdin. | `RestrictedCommand.Input` was declared and never written. The local MCP servers therefore waited for a request that never came, were reaped by the 30 second timeout and reported "Process terminated by SIGKILL: it exceeded the 30000ms timeout" as the turn's `setupError`. The TypeScript host writes the request and ends the stream; the Go host wrote nothing and never ended it. | The request is written to the child's stdin, and the stream is ended when the command does not keep it open, the way the TypeScript does. |
| DEV-020 | 2026-10-20 | The Pi worker was started with the node runtime the turn's own environment named. | `spawnPiWorker` resolved the node binary from the narrowed environment the turn grants its helpers, whose `PATH` holds no node. The fallback is the daemon's own executable, so the daemon started itself with the worker's entry as an argument and answered "Unknown argument: …/src/runtime/pi-worker.ts". The TypeScript host always answers with its own process path. | The worker runs on the node that hosts Graph: `GRAPH_APP_NODE`, else the `node` on the daemon's `PATH`. |
| DEV-021 | 2026-10-20 | The credential was looked up with the provider's model id. | The provider send rebuilt the model entry from the SDK-shaped model the provider sees, whose `id` is the provider's model id (`longcat-2.5-preview-free`) and not the configured one (`opencode-go:longcat-2.5-preview-free`). The lookup missed, so every turn failed with "No credential bound for model …". | The send carries the configured model entry, the one the TypeScript closes over. |
| DEV-022 | 2026-10-20 | A failing worker request took the whole daemon down. | The host answers the worker's requests on its own goroutine, and a request that raised (a model without a credential, for instance) unwound that goroutine. An unrecovered panic on any goroutine kills a Go process, so the desktop APP lost its backend mid-turn. The TypeScript host answers such a request with an error reply and the worker reports it as the turn's error. | The request handler recovers and answers with the reason, so the turn fails and the daemon keeps running. |
| DEV-023 | 2026-10-20 | The master node was dispatched twice for one message. | The TypeScript host runs one event loop, so the command that creates a conversation and the dispatch that answers it can never overlap. The Go host runs them on two goroutines, and the creation left the master node `pending` while the dispatch was already running; the second dispatch opened a second worker on the same instance directory, and the two workers raced for `instance.json`. | The master becomes dispatchable only once the message it has to answer exists, and the creation never parks a turn that is already running — the same guard the TypeScript's `say` already has. |

The evidence for the last one is in `migration/logs/deploy-app-turn.log`,
`migration/logs/deploy-app-turn-2.log` and `migration/logs/deploy-app-turn-3.log`:
three runs of the same message against the same configuration and the same real
provider, each of them dispatching the master exactly once — the probe counts the
assistant turns of the conversation and fails on a second one — and each of them
answered by the real model.

## The deployment itself

The port was installed as the backend of the packaged desktop APP, not next to it.
The shape of that deployment:

- The binary travels with the package. `scripts/package-app.mjs` copies
  `dist/graphd` into the stage and lists it in the electron-builder `files`, so the
  APP that starts the Go backend carries it. `desktop/main.mjs` finds it through
  `findPackagedDaemon`, which honours `GRAPH_DAEMON_BIN` and otherwise walks up
  from the source root looking for `dist/graphd`.
- The APP starts the backend as a child process with `--application-root
  <sourceRoot>`, and the source root is the checkout `~/.graph/app-root` names. The
  packaged shell in the reference checkout was left untouched; only the path in
  that file points at the port's checkout, and the previous value is kept beside it
  as `app-root.bak-<date>`.
- The node that runs the Pi worker ships with the package as `runtime/node` and is
  handed to the backend as `GRAPH_APP_NODE`. `scripts/package-app.mjs` copies it
  from `GRAPH_APP_NODE_BIN` and then runs `runtime/node --version` as a self-check,
  because a shim — the Homebrew node is a 68 KB `@rpath` shim — cannot be copied
  into a bundle and fails to load there.
- The backend publishes its address in its own state directory's `console.json`,
  the way the TypeScript server did, so the console and the probes find the same
  address the APP is serving.

The probe that checks all of this is `migration/app-probe.sh`. It reads the address
the running backend published, asks for the startup object, the real task list and
the provider usage, sends one message to the master, waits for its answer and reads
the event stream of that same conversation. The last three runs are
`migration/logs/deploy-app-turn.log`, `migration/logs/deploy-app-turn-2.log` and
`migration/logs/deploy-app-turn-3.log`; each of them answers with `configured:
true`, the real tasks, the provider usage of the user's own credentials, one
assistant turn and fourteen event frames of the documented shape.

## The wake path on both servers

`migration/logs/wake-ab-ts-vs-go.log` records the same scenario — the same provider and
the same graph — driven against the TypeScript server and against the Go process, once
with the confirmation written after the master's turn settled and once with the
confirmation written while that turn was still running. The three results that matter:

- The wake that names the confirmed graph reaches the model on both servers, in both
  variants. The sequence of provider requests is the same on the two servers:
  `MMM!M!wwww`.
- The node outcome differs. On the Go process both worker nodes end `succeeded`; on
  the TypeScript server both end `failed`, because that server fails a node whose
  provider turn reports no usage ("Execution ended after submit with unknown usage"),
  while the Go process costs that turn with an estimate and lets the node settle
  (DEV-018).
- An earlier run of this A/B dropped the wake on the TypeScript server in one of
  three runs, when the confirmation landed during a running turn. That did not
  reproduce: both servers delivered the wake in the variant that forces it.

## How this was checked

Every check below runs against the real Go process (`dist/graphd`), never against a
stand-in for it.

| Check | Command | Log |
|---|---|---|
| The whole E2E suite | `node_modules/.bin/vitest run tests/e2e` | `migration/logs/e2e-go-backend.log` |
| The productized flow | `node_modules/.bin/vitest run tests/m8/integration.test.ts` | `migration/logs/m8-integration-go.log` |
| Every route of the public surface | `bash migration/route-sweep.sh` | `migration/logs/route-sweep.log` |
| Two clean starts of the process | `bash migration/launch-probe.sh <n>` | `migration/logs/launch-<n>.log` |
| One SSE stream of the documented shape | `bash migration/sse-probe.sh <n>` | `migration/logs/sse-<n>.log` |
| The wake path on both servers | the A/B script of the log | `migration/logs/wake-ab-ts-vs-go.log` |
| The Go backend inside the running APP | `bash migration/app-probe.sh turn` | `migration/logs/deploy-app-turn.log`, `migration/logs/deploy-app-turn-2.log`, `migration/logs/deploy-app-turn-3.log` |

The E2E suite is load sensitive. It runs 49 files in parallel and the default test
timeout is 15 seconds, so on a busy machine a file that needs 15 to 25 seconds fails
on its timeout while the same file passes on its own. The runs of this session failed
in three different files (`harness-workflow`, `rework-runtime`, `agent-skills`), and
each of them passes when it is run on its own — also under deliberate load.

Every log in `migration/logs/` was written after the five defects of the deployment
run were fixed, except the reference run of the productized flow on the TypeScript
server, which is the other side of the comparison.

## Known open items

The 65 `TODO(port):`, 2 `PERF(port):` and 4 `BUG(port):` markers in `backend/internal/graph/`
are the port's own open list. They mark places where the TypeScript behaviour is not
reproduced yet, not places where the port silently differs: each one names the fact it
is missing.

The behaviour that used to be listed here — a confirmed graph that holds a single agent
node and no module does not reach a settled node state on the Go process — no longer
reproduces. The same graph, driven against both servers, ends `succeeded` on the Go
process, and the TypeScript server fails the same node for the usage reason above. The
earlier observation came from a test provider that dispatched the same input twice and
reported no usage, so the node was asked to submit again after a delivery it had
already answered.
