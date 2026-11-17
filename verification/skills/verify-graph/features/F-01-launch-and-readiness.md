# F-01 启动与就绪（launch / doctor / status）

一条命令起一个**隔离**的 Graph 实例，并判定它「可以开始验证了」。这是所有其它 feature 的前置。

- 入口：CLI，不是界面。`verify-graph launch`（daemon 车道）、`verify-graph launch --window`（窗口车道）
- 现有自动化覆盖：无（`app/daemon_test.go`、`app/daemon_phase_test.go` 只测状态机，不测真启动）
- 源码事实：`app/main.go:main()` → `ensureDaemon()`；daemon 就绪的唯一信号是 `<state>/console.json` 出现且 `/api/health` 回 `{"ok":true}`；没有 config 文件时 daemon 直接 `invalid_config` 退出

## Sub-features

- `build`：构建待验证二进制（`dist/graphd` 或 LD 改名后的窗口构建），记录 sha256。
- `launch`：把 `--state-dir/--graph-home/--config` 全指向 `.run/<run>/`，`--port 0`，默认 `--view-only`，写 `.run/<run>/instance.json`（pid + 启动时间 + 二进制 sha）。
- `status`：列出 `.run/*` 的实例状态（活着/可达/孤儿），并**只读**记录用户实例（`~/Library/Application Support/Graph/state/console.json`）——不驱动它。
- `doctor`：就绪判定（进程、端口归属、console.json 与 pid 一致、401 行为、二进制 sha、state 目录归属、agent-desktop 权限、用户 launchd 服务是否在跑、窗口 bounds）。
- `cleanup`：只杀 `instance.json` 记账且 argv 能对上的 pid，删 `.run/<run>`，保留 `evidence/<run>`。

## How to get to it (user POV)

用户视角没有这个页面：它替用户做完「打开 Graph」这一步，并把「到底起没起来」变成一句话结论，而不是让 Agent 自己 `ps`/`curl` 猜。

## Driving it with verify-graph

```sh
verification/verify-graph build
verification/verify-graph launch --json
verification/verify-graph status --run <runId>
verification/verify-graph doctor --run <runId>
verification/verify-graph cleanup --run <runId>
```

判过（断言，全部落 `evidence/<run>/F-01/assertions.json`）：
1. `console.json` 的 `pid` 等于 `instance.json` 的 `pid`，且该 pid 的 argv 含本 run 的 `--state-dir`；
2. `/api/health` = 200 `{"ok":true}`，无 cookie 的 `/api/conversations` = 401；
3. `/api/startup.source.root` 指向本仓库；
4. 从未写过 `~/Library/Application Support/Graph/**`（`guard` 指纹不变）；
5. `cleanup` 后 `kill -0 <pid>` 失败，且 `evidence/<run>` 仍在。

## Gotchas

- **没有 config 文件起不来**：`graphd` 对不存在的 `--config` 直接 `invalid_config` 退出（实测），`launch` 必须先写最小 config。
- **端口 0**：URL 只能从 `console.json` 读，不能假设 4173。
- **launchd 陷阱**：任何「用隔离 state-dir 起窗口」的路径都会让 App 走 `refresh()` → `launchctl bootout gui/<uid>/dev.graph.daemon`，把用户正在跑的守护进程顶掉（`app/launchd.go:38` 的 plist 路径与 state-dir 无关）。窗口车道必须带 `guard`（launchctl 影子 + 只读 LaunchAgents 闸），否则**不要**跑。
- 仓库里可能已有历史孤儿 daemon（本轮就见过 3 个指向已删 `.run/*` 的），`status` 只报 `stale`，不代杀。
