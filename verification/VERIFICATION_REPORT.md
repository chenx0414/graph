# Graph 验证能力：怎么用、验了什么、证据在哪

唯一入口：`/Users/macmini/workspace/13-Graph/verification/verify-graph`（Go，标准库）。
唯一 skill：`verification/skills/verify-graph/`（`SKILL.md` + `features/`，冷启动只读这里）。

---

## 1. 结论（本轮实测）

```
cd /Users/macmini/workspace/13-Graph/verification
./verify-graph verify --all
```

- 结果：**23/23 通过**，退出码 `0`，耗时 **56.2 s**（本机，2026-11-17 14:46:11 开跑、14:47:07 结束）。
- runId：主 run `a8290242`（view 实例，22 条 journey）；execute 实例 `e353d253`（F-04 真实一轮对话）。
- 证据根：`verification/evidence/a8290242/`、`verification/evidence/e353d253/`；
  `evidence verify` 重算 104 + 6 个文件，`problems: []`。
- 每条 journey 都是独立文件、独立证据目录、独立结论；失败时 `data.failures[]` 给出
  journey / 预期 / 实际 / 证据 / 复现命令（见 §5）。

一次跑完会按 journey 声明的实例自动分组：普通页面跑 view 实例；需要真实 dispatch 的 F-04 自动起
execute + 本地替身模型；F-15 托盘自动走 surface 车道。`--lane window` 可以把同一批 journey 放到真实窗口里再跑一遍。

真实窗口车道也是绿的（同代码实测）：`./verify-graph verify --all --lane window` **23/23 通过**，耗时 **274 s**（run `6473fb09` + execute `c0405509`）。每一步按 AX `role+name` 点击/键入，留 AX dump + PNG；`evidence verify` 重算 104 + 6 个文件，`problems: []`。证据根：`verification/evidence/6473fb09/`、`verification/evidence/c0405509/`。

---

## 2. 怎么用（冷启动三条命令）

```sh
cd /Users/macmini/workspace/13-Graph/verification

./verify-graph doctor                       # 这台机器现在值不值得驱动（只读，退出码 3 = 环境问题）
./verify-graph verify --journey F-09        # 只验一个功能
./verify-graph verify --all                 # 全套 23 条
```

再加两条复核命令：

```sh
./verify-graph evidence verify --run <run>  # 重算证据 sha256，证明没人改过
./verify-graph verify --all --lane window   # 同一套 journey 在真实窗口里跑（需要辅助功能授权）
```

只想知道某个控件到底叫什么、点一下会不会变，用逐控件动词（复用本 run 自己的真窗口，每次落 AX JSON + PNG）：

```sh
./verify-graph ui text --run <run>                                  # 列出可访问树里的所有名字
./verify-graph ui expect --run <run> --name 洞察概览窗口 --role group
./verify-graph ui click --run <run> --name 洞察 --expect 洞察概览
./verify-graph ui screenshot --run <run> --out evidence/<run>/manual/insights.png
```

约定：stdout 只有一个 JSON 信封
`{command, ok, runId, lane, data, artifacts, warnings, nextActions, error}`，人读提示走 stderr。
退出码：`0` 通过 / `1` 断言失败 / `2` 用法 / `3` 环境 / `4` 超时。

其它命令：`build launch status api ui scenario seed evidence cleanup help version`。
`cleanup --orphans [--dry-run]` 只清理 `verification/.run/` 下没有活 run 记录、且命令行与开工时间都对得上的
`graphd` 守护进程；不会按名字杀进程，也不会碰用户的 Graph。

---

## 3. 验了什么（本轮 23 条，逐条实测）

| journey | feature | 实例/车道 | 步骤 | API 检查 | 证明的关键事实 |
| --- | --- | --- | --- | --- | --- |
| `F-02-nav` | F-02 模块导航 | view / headless | 32 | 0 | 七个 rail 逐个点开，每页出现自己的页签与面板窗口 |
| `F-03-conversations` | F-03 会话列表 | view / headless | 5 | 1 | 空实例不白屏；会话题目与 main agent 卡片存在 |
| `F-04-conversation` | F-04 对话渲染 | execute / headless | 6 | 3 | 替身模型真的跑完一轮；用户句与 assistant 回答逐字出现在消息流；token 记录 40/10 |
| `F-05-composer` | F-05 输入区 | view / headless | 6 | 3 | 键入后 `消息` 的 AX **value** 逐字等于输入；消息数不变（未发送） |
| `F-06` | F-06 上下文窗口 | view / headless | 10 | 1 | `当前上下文窗口` + 三页签可点，空态记 skipped |
| `F-07` | F-07 白板布局 | view / headless | 7 | 1 | 默认白板页签、洞察页签、切回；布局来自真实 `shellState` |
| `F-08` | F-08 轨迹页 | view / headless | 6 | 1 | `标签页 轨迹量化` + `上下文统计窗口` + `Token 统计窗口` |
| `F-09` | F-09 洞察页 | view / headless | 6 | 2 | `洞察概览窗口` + `用量趋势窗口` + `会话排行窗口`；API 回读 |
| `F-10` | F-10 编队页 | view / headless | 5 | 1 | `标签页 编队` + `编队` 面板 |
| `F-11` | F-11 供应商页 | view / headless | 4 | 2 | `供应商窗口`；Magpie 状态可读 |
| `F-12` | F-12 资源页 | view / headless | 4 | 2 | `资源库窗口`；catalog 可读 |
| `F-13` | F-13 装配页 | view / headless | 4 | 1 | `能力装配窗口`；catalog/组合可读 |
| `F-14` | F-14 设置页 | view / headless | 5 | 3 | `标签页 运行设置` + `运行设置`；config/limits/startup 回读 |
| `F-15-tray` | F-15 托盘 | view / surface | 6 | 1 | 本 run 窗口的 `menu-bar-extras` 里 `打开 Graph`/`退出 Graph` 均为 menuitem；只点未命名托盘根，绝不点退出 |
| `F-16-empty-and-error` | F-16 空态/错误态 | view / headless | 9 | 3 | 无数据下编队/资源页仍渲染面板；health/startup/fleet 全 200 |
| `rail-insights` | 侧栏级 | view / headless | 8 | 0 | 点侧栏 → 页签/面板真的换了 |
| `rail-fleet` | 侧栏级 | view / headless | 6 | 0 | 同上 |
| `rail-providers` | 侧栏级 | view / headless | 8 | 0 | 同上 |
| `rail-capabilities` | 侧栏级 | view / headless | 8 | 0 | 同上 |
| `rail-assemblies` | 侧栏级 | view / headless | 8 | 0 | 同上 |
| `rail-settings` | 侧栏级 | view / headless | 6 | 3 | 同上 + daemon 回读 |
| `rail-trajectory` | 侧栏级 | view / headless | 10 | 3 | 同上 + 轨迹量化数据 |
| `shell-workspace` | 外壳/工作区 | view / headless | 12 | 3 | shell 级布局与状态 |

F-01（启动与就绪）是入口本身：`doctor`/`launch`/`status`/`cleanup` 由
`acceptance/acceptance_test.go` 黑盒覆盖，且每次 `verify --all` 都必须先成功 `launch` 才能开始。

---

## 4. 证据在哪、怎么复核

```
verification/evidence/<runId>/<feature>/
  assertions.json      每条断言的 id / expected / actual / evidence 路径
  summary.json         ok / passed / failed / steps / 起止时间 / commit / lane
  result.json          渲染树文案、access[{name,role,value}]、每步 outcome
  manifest.json        目录内除自身外每个文件的 sha256 + bytes
  *.png                人可复核截图（headless 渲染帧 / 窗口区域 / 托盘区域）
  check-NN.json        对应 /api/* 的请求与响应体
  seed.json            （F-04）那一轮真实对话：conversation/task/assistantText/tokens
  surface.json         （F-15）surface、窗口、元素树
verification/.run/<runId>/                   # 运行态（cleanup 删除）
```

隔离铁律（每 run 一套，已实测与用户实例并存）：

- `GRAPH_STATE_DIR` / `GRAPH_CONFIG` / `GRAPH_HOME` 指向 `.run/<id>`；
- `HOME` / `TMPDIR` / `XDG_RUNTIME_DIR` 重定向；
- `PATH` 首位放 `launchctl` 影子（exit 1 并记录调用），`doctor` 会现场证明影子真的生效；
- 两套窗口构建：`ui motion` 用 `-X mygo.packageIdentifier=dev.graph.verify.<id>` 重编译，单实例锁与 app-support 目录都和用户 Graph 分开；`ui window` 复用 `dist/app` 的 adhoc 构建，但 `HOME` / `GRAPH_STATE_DIR` / `GRAPH_CONFIG` 全部重定向到本 run，窗口与托盘只按本 run 的 window id scope 读取，不按 `Graph` app 名（同名多实例时 `--app Graph` 会 AMBIGUOUS_TARGET）；
- `cleanup` 只杀 `run.json` 记账且进程身份核对过的 pid；`launch` 用 keeper 父进程避免 app 把 daemon 当 launchd 托管后停掉。

---

## 5. 失败时你看到什么

`verify --all` 失败时 `ok=false`、退出码 1，`data.failures[]` 每条都包含：

- `journey` / `feature` / `path`（用户路径）；
- `expected` / `actual`（逐字差异）；
- `failedSteps[]`（第几步、什么动作、实际看到什么）；
- `failedChecks[]`（API 期望/实际/证据文件）；
- `evidence`（断言 JSON 与截图路径）；
- `nextCommand`（只复现这条路径的命令，例如 `verify-graph verify --journey F-09`；window 车道会带
  `--lane window`。`verify --all` 结束时会停掉实例，所以提示不再钉一个已停止的 `--run`；要复核那次证据就用
  `runId` 与 `evidence` 路径）。

`error.hint` 直接给出同一条复现命令。单个 journey 也可以用 `--lane window` 复跑到真实窗口里定位。

---

## 6. v1“已知限制”逐条结论

| v1 限制 | 本轮结论 |
| --- | --- |
| 1. F-04 对话渲染、F-15 托盘没有 journey | **已覆盖**。F-04 用 `instance: execute` + 本地替身模型真的跑完一轮（`seed.json`：assistant 文本、messages=2、turns=1、input 40 / output 10）；F-15 用 `surface: menu-bar-extras` 读取本 run 窗口的托盘并按窗口 scope 打开未命名根，断言两个菜单项。两者都在 `verify --all` 里。 |
| 2. 窗口车道多步驱动会断 | **已修**。`ui window open` 写 `instance.json`，`click/shot/close` 读同一份记录；daemon 改由 keeper 父进程持有，避免被 app 当成 launchd 托管而停掉。`acceptance` 有 `VERIFY_GRAPH_WINDOW=1` 的多步回归。 |
| 3. `checks[].expect` 是深相等 | **已改成子集递归匹配**；另留 `expectExact` 做精确匹配。嵌套对象/数组只要求期望字段存在且相等，响应里随调度变化的字段不再让检查翻转；有单测 `TestChecksMatchSubsetsByDefaultAndExactWhenAsked`。 |
| 4. 截图必须带区域 | **保留为事实并写进 skill**。窗口/托盘截图按 bounds 区域抓；拿不到真实 bounds 时失败并报坐标，不写黑图。 |
| 5. `launchctl` 是全局共享资源 | **已加固**。窗口 PATH 的 launchctl 影子是必需的；`doctor` 新增 `launchctl-shim` 检查，现场执行并断言它拒绝 `bootstrap`。 |
| 6. 孤儿 daemon 只报不清 | **已实现** `cleanup --orphans`：只处理 `verification/.run/<id>` 下、无活 run、年龄超过 `--older-than`（默认 120s）、命令行与开工时间都核对的进程；支持 `--dry-run`；有单测与 acceptance 覆盖。 |
| 7. headless 与真实窗口不是同一件事 | **两条车道都在且都留了证据**：`verify --all` 默认 headless（终版证据见 §1）；`verify --all --lane window` 用同一批 journey 在真实窗口里按 AX `role+name` 驱动，实测 **23/23**（run `6473fb09` + `c0405509`，274 s，104 + 6 个证据文件 `problems: []`）。`acceptance` 的 `TestTheWindowLaneDrivesSeveralStepsOnOneLiveDaemon`（`VERIFY_GRAPH_WINDOW=1`）钉住多步驱动回归。F-15 只能用 surface 车道，这一点写进了 feature 的 Gotchas。 |

---

## 7. 仍然没覆盖的（明确标注，不装成已覆盖）

- **消息动作条**（复制/赞/踩/朗读/更多）、markdown 表格/代码块、长会话分页：只有 `app/chat_*_test.go` 单测，
  未进 journey；F-04 的“判过”只声称消息流与 token 链路。
- **系统通知点击回到会话**：需要先产生真实待答/完成任务，没有稳定、不打扰用户的做法；
  `notifications.json` 作为证据保留，但不作为 pass 条件。F-15 的“判过”只声称托盘菜单项。
- **托盘“打开 Graph”再开窗**：会抢焦点，不在 journey 里点；`ui window close` 后 daemon 仍 healthy 由 acceptance 覆盖。
- **窗口车道**依赖辅助功能授权与屏幕可见性；`doctor` 退出码 3 时是环境不能判，不是产品失败。

这些都在对应 `features/F-XX-*.md` 的 `Gotchas` / “尚未覆盖”里逐条写明。

---

## 8. 加一个新功能怎么接

1. 在 `skills/verify-graph/features/` 写 `F-XX-*.md`（四个 H2：`Sub-features` / `How to get to it (user POV)` /
   `Driving it with verify-graph` / `Gotchas`）；
2. 在 `features/index.json` 加一条：`id/file/command/scenario/evidence/api/measured/provenInJourney`；
3. 写 `scenarios/F-XX.json`：
   - `instance: "execute"` + `seed`：需要真实 dispatch 时自动起替身模型；
   - `surface: "menu-bar-extras"`：shell surface（托盘）车道；
   - `prepare` → `steps`（`click`/`type`/`key`/`waitText`/`assertText`/`assertAccess`/`screenshot`/`open`）
     → `checks`（`expect` 子集 / `expectExact` 精确 / `expectStatus`）；
4. `./verify-graph verify --journey F-XX` 跑通，把实测文案与坑写进 `Gotchas`；
5. `go test ./...` 会检查 skill 结构、文档里出现的每条命令真实存在、证据三件套与命令面契约。

这套东西自己也被验证：`acceptance`（黑盒跑 CLI）、`internal/skilldoc`（skill/Feature Map 结构与命令真实性）、
`internal/evidence`（manifest 与 `evidence verify`）、`cmd/verify-graph`（信封、断言匹配、seed、诊断、cleanup）。
