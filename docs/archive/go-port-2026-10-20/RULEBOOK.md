> 历史记录：首次 Go 逐文件移植时的约束与差异，保留原文供追溯。当前运行边界以 [ADR 0032](../../adr/0032-go-backend-shared-durable-host.md) 和 [架构](../../architecture.md)为准；其中本地探针日志未发布到仓库。

# Translation Rulebook — TypeScript → Go

The meta-rule: if two agents could answer a question differently, the answer is here. Read this whole document before writing code.

This is a structure-preserving port of the Graph APP backend. Same architecture, same data structures, same public HTTP/SSE/CLI behavior. Do not redesign routes, JSON shapes, SQLite tables, or config files. The TypeScript in `src/server`, `src/core`, `src/runtime`, `src/catalog`, and `src/git` is the spec. The React UI (`src/web`) and the Electron shell (`desktop/`) stay TypeScript. Resident Pi and other Node worker processes stay Node.

Go's typecheck is cheap. `gofmt` every file you write. Do not add `*_test.go` files. Do not add vitest unit or integration tests. The judge is the existing `tests/e2e` suite against this process.

## 0. Scope

- Port only your assigned files. One source file becomes one Go file (see §4).
- Do not edit `backend/internal/graph/errors.go`, `sqlite_open.go`, `jsonutil.go`, `http_client.go`, or `backend/cmd/graphd/main.go`. They are shared.
- Do not delete TypeScript sources. They remain the reference and the in-process judge for tests that import them.
- `.mjs` and `.cjs` workers are not translated. Go spawns `node` on the same paths.
- Files under `@earendil-works/pi-coding-agent` and `pi-ai` are not reimplemented. Model HTTP and the resident worker are the boundaries in §7.
- First pass optimizes for behavioral fidelity. Mark a known slow faithful choice `PERF(port):`. Mark a reproduced TypeScript bug `BUG(port):`. Mark an undecided case `TODO(port):` and keep moving.

## 1. Ecosystem

| Area | Decision | Why |
|---|---|---|
| Module | `github.com/chenx0414/graph/backend` | Matches the Git remote. |
| Package | One package, `graph`, for all translated backend files | `core`, `runtime`, `catalog`, `git`, and `server` import each other in cycles. Go forbids that. One package keeps the call graph. This is not a redesign of the data model. |
| HTTP | `net/http` only | The Fastify app was a router, a 24 MiB JSON limit, and an error handler. No gin, echo, or chi. |
| SQLite | `modernc.org/sqlite` via `database/sql`, opened only through `OpenSQLite` / `MustOpenSQLite` | Pure Go, one connection (`MaxOpenConns(1)`), same PRAGMAs as `DatabaseSync`. |
| JSON | `encoding/json`. API bodies are structs whose field order matches the TypeScript object literal. `CanonicalJSON` for the command log. | `encoding/json` sorts map keys; TypeScript object order is insertion order. Structs preserve the order tests compare. |
| UUID | `crypto/rand` 16 bytes as 8-4-4-4-12 hex, or `github.com/google/uuid` | `node:crypto` `randomUUID`. |
| Time | `NowMillis()` for `Date.now()` | Milliseconds, not `time.Time` in stored JSON. |
| Errors | `Raise` / `RaiseStatus` / `RaiseField` (panic `*RuntimeError`) | TypeScript `throw` is the control flow. See §2. |
| Concurrency | Goroutines only where TypeScript `await` overlapped real I/O or a drive loop | SQLite calls were synchronous. Do not make them async. |
| Third-party | Nothing else without a row in this table | Agents must not each pick a router or an ORM. |
| Tests | None in Go | E2E stays in `tests/e2e`. |

## 2. Constructs

| Source | Go | Notes |
|---|---|---|
| `throw new RuntimeError(code, message)` | `Raise(code, message)` | HTTP boundary recovers to 400 `{code,message}`. |
| `error.field = path` on invalid config | `RaiseField(code, message, field)` | Response includes `field` only when set. |
| `Object.assign(new Error(msg), {statusCode, code})` | `RaiseStatus(status, code, msg)` | 401 `unauthorized`, 403 `forbidden` / `forbidden_origin`. |
| Other thrown `Error` | `panic(err)` | HTTP maps it to 500 `{code:"internal",message}`. |
| `try/catch` around a domain call | `defer` + `recover` in a nested func, or return the error if the catch is local | Do not swallow a `RuntimeError` the TypeScript catch did not swallow. |
| `try/finally` | `defer` | |
| `null` / missing object field | `nil` pointer, or `omitempty` only when TypeScript omitted the key | `null` in JSON is a pointer with no omitempty. Omitted key is `omitempty`. |
| `undefined` dropped by `canonicalJson` | leave the map key out; `CanonicalJSON` also drops the `undefined` sentinel | |
| `Map` / `Set` iterated into JSON or a stable list | slice plus map, insertion order | Plain `map` is fine when order is not observed. |
| `Date.now()` | `NowMillis()` | |
| `randomUUID()` | lower-case UUID string | |
| `Buffer` | `[]byte` | |
| `async` function that only awaits SQLite or other sync work | ordinary function | |
| `for await` of an SSE watch | goroutine plus channel, or a loop with `http.Flusher` | Frame bytes are specified in §6. |
| `instanceof RuntimeError` | type assert `*RuntimeError` | |
| Class | struct plus methods. Constructor is `NewX` or `OpenX` matching the TypeScript export. | |
| Optional property `foo?: T` | pointer or a second boolean, matching whether JSON emits `null` or omits the key | |
| Enum string union | `type Name string` plus the same constants | |
| `as` casts | delete them; encode the real type | |
| Import cycles | gone, because there is one package | Do not introduce a second package inside the port. |

The BUG rule: reproduce defective TypeScript behavior and mark `BUG(port):`. Do not fix it in this port.

The UNKNOWN rule: when this table does not decide, pick the conservative representation, mark `TODO(port):`, continue.

`CapabilityLoadFact` is declared in both `src/core/node-run.ts` and `src/runtime/capabilities.ts`. Define it once. If the fields differ, keep the core name and name the runtime one `RuntimeCapabilityLoadFact`.

Unexported function names that collide across files, and only these, get the source file stem as a prefix (`configInvalid`, `storeText`): `text`, `record`, `writeAtomic`, `main`, `invalid`, `asArray`, `object`, `tokenTotal`, `isRecord`, `within`, `slug`, `aborted`, `digest`, `inside`, `textFromMessage`. Every other name keeps a mechanical spelling.

## 3. Escape hatch

`unsafe` is banned. `panic` is allowed only for the TypeScript `throw` mapping in §2, and must be a `*RuntimeError` or the original error value.

Markers, exact spelling: `TODO(port):`, `PERF(port):`, `BUG(port):`.

## 4. Names and paths

| Source | Go file |
|---|---|
| `src/<area>/<name>.ts` | `backend/internal/graph/<area>_<name>.go` |

`<area>` is `server`, `core`, `runtime`, `catalog`, or `git`. Hyphens in the file name become underscores. Example: `src/core/task-runtime.ts` → `backend/internal/graph/core_task_runtime.go`.

Package name on every file: `graph`.

Spelling:

- Exported TypeScript function `canonicalJson` → `CanonicalJson` (uppercase the first letter only; do not invent `CanonicalJSON` except the shared helper, which is already named `CanonicalJSON`).
- Exported type `TaskStore` → `TaskStore`.
- `SCHEMA_VERSION` and other `UPPER_SNAKE` consts stay `UPPER_SNAKE`.
- Methods of a class become exported methods (`Event`, `Transaction`, `Command`) so call sites match across files.
- A call to another file's export uses that Go name. There are no import paths inside package `graph`.

Shared helpers already in the package, do not redeclare them:

- `Raise`, `RaiseStatus`, `RaiseField`, `RuntimeError`, `PublicError`
- `OpenSQLite`, `MustOpenSQLite`
- `CanonicalJSON`
- `ApplicationRoot`, `HTTPClient`, `NowMillis`, `VendorOriginRewrites`

`func RunCLI(args []string)` lives in `server_cli.go`. `cmd/graphd` calls it. It does not return; it exits the process with the same codes as `src/server/cli.ts` (usage 2, start failure 1, clean stop 0, second signal or stop timeout 1).

## 5. Gap inventory

`migration/inventory.tsv` lists every backend file and its Go path. Implementers do not re-decide file placement. Nullability and error-kind notes that a translator cannot settle are appended as extra TSV rows rather than invented locally:

```
file	symbol	source_construct	classification	target_translation	evidence	status
```

## 6. Public surface that must not drift

### Process

- Binary: `dist/graphd`, built from `backend/cmd/graphd`.
- Bind `127.0.0.1` only. Port `0` tries the port in `<stateDir>/console.json` for up to 5s, then binds a free port. A taken explicit port exits with `port_in_use`.
- Banner, exact labels, so `parseBannerAddress` matches:

```
Graph console
  mode:      view-only (history, settings and graph; no model dispatch)
  config:    <path or none — first run; add graph.config.json to enable projects and models>
  state:     <stateDir>
  web:       <webDir>
  models:    <modelCount> configured, <enabledModelCount> enabled
  address:   http://127.0.0.1:<port>
  stop:      Ctrl-C / SIGTERM (bounded 5s stop)
The browser is only a client; closing it does not stop the daemon.
```

Execute mode text is `execute (task dispatch enabled)`.

- After listen, write `<stateDir>/console.json` (mode `0600`, 2-space JSON, trailing newline): `{"url","pid","mode","startedAt"}`. `mode` is `view` or `execute`. `pid` is this process. Do not delete the file on stop.
- Write `<stateDir>/app-token` (mode `0600`) as `<uuid>\n` before serving.
- Missing `<webDir>/index.html` refuses startup with code `web_build_missing`.
- SIGINT/SIGTERM: first signal stops within 5s; a second signal exits 1 immediately. Stop timeout exits 1.

### Session and errors

- Cookie name `graph_session`. `GET /` sets `set-cookie: graph_session=<uuid>; HttpOnly; SameSite=Strict; Path=/` and returns `index.html`.
- `/`, `/assets/*`, and `/api/health` skip auth.
- `/api/app/*` requires header `x-graph-app-token` equal to the app token, else 403 `{"code":"forbidden","message":"App bridge token required"}`.
- Other `/api/*` require the cookie, else 401 `{"code":"unauthorized","message":"Authentication required"}`.
- Non-GET under `/api/*` also requires an `Origin` of `127.0.0.1` or `localhost`, else 403 `forbidden_origin`.
- Any request with an `Origin` that is not local is 403 `forbidden_origin`.
- JSON body limit is 24 MiB.
- `RuntimeError` responses are 400 `{"code","message"}` plus `field` when set. They are not 404.

### Startup JSON

`GET /api/health` → 200 `{"ok":true}`.

`GET /api/startup` (with the session cookie) → 200 object containing at least:

- `mode`: `"view"` or `"execute"`
- `configured`: bool, true when at least one model has a resolved credential
- `modelCount`: number of configured model entries
- `enabledModelCount`: number of models with a resolved credential
- `effectiveRevision`: number
- `source`: `{root, commit, branch, dirty}` from `readSourceIdentity(ApplicationRoot)`, read once at startup
- `limitAliases` only when non-empty

A view-only boot with no config is `configured:false`, counts `0`.

### SSE

Both existing streams:

- `GET /api/conversations/:conversationId/events/stream?after=<n>`
- `GET /api/tasks/:taskId/events/stream?after=<n>`

Response headers: `content-type: text/event-stream`, `cache-control: no-cache`, `connection: keep-alive`. Flush headers before the first event. Each event is one frame:

```
data: <json>\n\n
```

No `event:` line. Conversation frames are JSON objects `{cursor, taskId, type, data, timestamp}` in that field order, replayed for `cursor > after`, then live. JSON uses `CanonicalJSON` field order only for stored payloads; the frame object itself uses the field order above. Disconnect ends the watch.

### Routes

Register every route below. Paths and methods stay exact. `PROVIDER_ROUTES` adds `GET /api/providers` and `POST /api/providers/probe`.

```
GET    /
GET    /api/health
GET    /api/startup
GET    /api/agent-context
PUT    /api/agent-context/prompts
PUT    /api/agent-context/prompts/default
POST   /api/agent-context/prompts/default/reset
POST   /api/agent-context/prompts/reset
PUT    /api/agent-context/tools
GET    /api/usage
POST   /api/usage/refresh
GET    /api/usage/credentials
GET    /api/model-pricing
POST   /api/providers/login
GET    /api/providers/login/:id
POST   /api/providers/login/:id/cancel
POST   /api/providers/disconnect
GET    /api/providers
POST   /api/providers/probe
POST   /api/app/secret
GET    /api/app/secret-requests
GET    /api/app/rsi/status
POST   /api/app/rsi/restart-ack
GET    /api/limits
GET    /api/tool-stats
POST   /api/tool-stats/clear
GET    /api/skill-stats
POST   /api/skills/promote
GET    /api/config
POST   /api/config
POST   /api/pricing/refresh
POST   /api/config/test
GET    /api/settings
GET    /api/capabilities/config
GET    /api/tasks
GET    /api/inbox
GET    /api/projects/:projectId/entries
GET    /api/conversations
POST   /api/conversations
GET    /api/conversations/:conversationId
GET    /api/messages/:messageId/attachments/:index
GET    /api/conversations/:conversationId/history
GET    /api/conversations/:conversationId/artifacts
GET    /api/conversations/:conversationId/draft-graph
GET    /api/conversations/:conversationId/proposals/:version
POST   /api/conversations/:conversationId/messages
POST   /api/conversations/:conversationId/messages/:messageId/cancel
POST   /api/conversations/:conversationId/model
POST   /api/conversations/:conversationId/compact
POST   /api/conversations/:conversationId/archive
POST   /api/conversations/:conversationId/unarchive
POST   /api/conversations/:conversationId/bind
POST   /api/conversations/:conversationId/confirm
POST   /api/conversations/:conversationId/drafts/archive
POST   /api/conversations/:conversationId/drafts/restore
POST   /api/conversations/:conversationId/drafts/delete
POST   /api/conversations/:conversationId/pause
POST   /api/conversations/:conversationId/resume
POST   /api/conversations/:conversationId/steer
POST   /api/conversations/:conversationId/interrupt
GET    /api/conversations/:conversationId/events
GET    /api/conversations/:conversationId/events/stream
POST   /api/tasks
GET    /api/tasks/:taskId
POST   /api/tasks/:taskId/say
POST   /api/tasks/:taskId/accept
POST   /api/tasks/:taskId/abandon
POST   /api/tasks/:taskId/pause
POST   /api/tasks/:taskId/resume
POST   /api/tasks/:taskId/budget
POST   /api/tasks/:taskId/answer
GET    /api/tasks/:taskId/events
GET    /api/tasks/:taskId/events/stream
POST   /api/tasks/:taskId/nodes/:nodeId/messages
GET    /api/tasks/:taskId/nodes/:nodeId/run
GET    /api/tasks/:taskId/nodes/:nodeId/prompt
GET    /api/tasks/:taskId/operations
POST   /api/tasks/:taskId/graph/control
GET    /api/tasks/:taskId/graph/modules/:moduleId
GET    /api/tasks/:taskId/graph/modules/:moduleId/values
GET    /api/tasks/:taskId/graph/modules/:moduleId/transitions/:transitionId
GET    /api/tasks/:taskId/graph/edges/:edgeId
GET    /api/tasks/:taskId/graph/edges/:edgeId/deliveries/:deliveryId
GET    /api/tasks/:taskId/graph
GET    /api/tasks/:taskId/artifacts
GET    /api/projects/:projectId/artifacts
GET    /api/tasks/:taskId/artifacts/:artifactId
GET    /api/tasks/:taskId/artifacts/:artifactId/:version/content
POST   /api/tasks/:taskId/artifacts/:artifactId/:version/retire
POST   /api/tasks/:taskId/artifacts/:artifactId/:version/promote
GET    /api/catalog
POST   /api/catalog/refresh
GET    /api/catalog/pi-extension-updates
GET    /api/catalog/pi-packages
POST   /api/catalog/pi-extensions/:id/:version/update
POST   /api/catalog/combinations
POST   /api/catalog/combinations/:id/description
DELETE /api/catalog/combinations/:id
POST   /api/catalog/combinations/:id/compile
GET    /api/catalog/definitions/:definitionId
GET    /assets/*
```

Static `/assets/*` is files under `<webDir>/assets`. `GET /` reads `<webDir>/index.html` on every request.

### On-disk formats

- `graph.config.json`: versioned document. Secrets are never stored. A credential has `secretRef` naming an environment variable. Parser behavior, including `field` on invalid documents, follows `src/server/config.ts`.
- `<stateDir>/tasks.sqlite`: `PRAGMA user_version` up to 42. Copy the migration SQL from `src/core/store.ts` verbatim, including later `ALTER`s. A database newer than this runtime raises `schema_version`.
- `<stateDir>/owner.sqlite`: `PRAGMA journal_mode=DELETE` and `BEGIN EXCLUSIVE` for the process lifetime. Busy is `owner_busy`. Rollback and close on shutdown. Do not use WAL for this file (`OpenSQLite` is wrong for it; open it separately).
- `<stateDir>/revoked-secrets.json`: pretty JSON array of strings, sorted, trailing newline, mode `0600`. An unreadable file fails closed by revoking every configured credential.
- `<stateDir>/app-token`, `<stateDir>/console.json`: as above.
- Other state directories (`instances/`, `conversations/`, `artifact-workspace/`, `prompts/`, `rsi/`, `process-scratch/`) keep the same relative paths the TypeScript code uses.
- User home capabilities and recipes stay under the graph home (`--graph-home`, else `GRAPH_HOME`, else `~/.graph`).
- Call-broker and kernel tables keep their current file names and SQL.

## 7. Pi and Node workers

Do not translate the Pi SDK. Where TypeScript called `ModelRuntime` or `fetch` against a provider `baseUrl`, call that HTTP API with `HTTPClient` (it applies the e2e OpenRouter rewrite when `vendor-transport.mjs` exists). Where TypeScript spawned a resident worker, spawn the same `node` entry (`src/runtime/resident-worker-entry.ts` and the `.mjs` / `.cjs` helpers) with the same args, cwd, and env. The Go process serves HTTP itself. It must not proxy requests to a TypeScript Fastify server, and it must not start `src/server/cli.ts` or `createApp`.

## 8. CLI flags

Same flags as `src/server/cli.ts`: `--config`, `--state-dir`, `--graph-home`, `--web-dir`, `--port`, `--execute`, `--dynamic`, `--view-only`, `-h`, `--help`. Environment fallbacks: `GRAPH_CONFIG`, `GRAPH_STATE_DIR`, `GRAPH_HOME`, `GRAPH_WEB_DIR`, `GRAPH_PORT`. Default port 4173. `--port 0` prefers the remembered port. `--execute` and `--view-only` together is usage error exit 2. Unknown argument is usage error exit 2.

Also accept `--application-root <path>` (the checkout this process represents). When it is absent, use the current working directory if it contains `package.json`, otherwise the directory containing the binary's source tree. `ApplicationRoot` is set from that value before any request.

## 9. Deviation log

| ID | Date | Deviation | Sanctioned by |
|---|---|---|---|
| DEV-001 | 2026-10-19 | Per-file `PORT STATUS` trailers from the kit template are omitted. The judge is public HTTP/SSE/CLI behavior, and trailers are not a parity signal. | port plan |
| DEV-002 | 2026-10-19 | One Go package instead of five directories, because the TypeScript import graph cycles and Go cannot. File boundaries stay one-to-one. | port plan |
