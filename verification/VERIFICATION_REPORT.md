# Graph 验证基础设施——怎么用、验了什么、证据在哪、还缺什么

唯一入口：`/Users/macmini/workspace/13-Graph/verification/verify-graph`（Go，只用标准库）。
唯一 skill：`verification/skills/verify-graph/`（`SKILL.md` + `features/`）。

---

## 1. 怎么用（三条命令够用）

```sh
cd /Users/macmini/workspace/13-Graph/verification

./verify-graph doctor                       # 这台机器现在值不值得跑（只读）
./verify-graph verify --journey F-14        # 验一个功能（每条 feature 一个 journey）
./verify-graph verify --all                 # 全套 21 条
```

- 每次调用 stdout 只有一个 JSON 信封：`{command, ok, runId, lane, data, artifacts, warnings, nextActions, error}`；
  人读提示走 stderr。退出码：`0` 通过 / `1` 断言失败 / `2` 用法 / `3` 环境 / `4` 超时。
- 失败时 `error.{code,message,hint}` 里必须给出下一步命令（例如 `verify-graph ui snapshot --run <id>`）。
- 其它子命令：`build launch status api ui scenario seed evidence cleanup help version`
  （`ui render|snapshot|window|motion` 是四条驱动车道，见 §5）。

「这个功能到底能不能用」的完整回答路径：

```sh
./verify-graph verify --journey F-09                       # 1. 跑
cat evidence/<run>/F-09/assertions.json                    # 2. 哪条断言、期望、实际
open evidence/<run>/F-09/*.png                             # 3. 人复核截图
./verify-graph evidence verify --run <run>                 # 4. 证据未被篡改（重算 sha256）
./verify-graph api GET /api/insights --run <run>           # 5. 直接回读同一状态
```

---

## 2. 验了什么（本轮实测，不是设计意图）

`./verify-graph verify --all` 在隔离实例上跑完 21 条 journey、约 62–82 秒，**21/21 通过**
（本机实测两次：run `3deff78b`（我）与 run `310865c4`（captain 亲跑，退出码 0））。

| feature | journey | 断言要点 | API 回读 |
| --- | --- | --- | --- |
| F-01 启动与就绪 | （CLI 本身就是入口） | `doctor`/`launch`/`status`/`cleanup` 的自检 | `/api/health`、`/api/startup` |
| F-02 模块导航 | `F-02-nav` | 32 步：七个 rail 文字 + 每页页签/面板窗口 | — |
| F-03 会话列表 | `F-03-conversations` | 空实例不白屏；会话行渲染 | `/api/conversations` |
| F-04 对话渲染 | （未覆盖，见 §4） | — | — |
| F-05 输入区 | `F-05-composer` | 键入后 `消息` 的 AX **value** 逐字等于输入（不是「看到文字」） | `/api/conversations` 计数不变（未发送） |
| F-06 上下文窗口 | `F-06` | `当前上下文窗口` + 三页签按钮可点（空态记 skipped） | `/api/agent-context` |
| F-07 白板布局 | `F-07` | `标签页 白板` → 洞察页签 → 切回 | `/api/settings` |
| F-08 轨迹页 | `F-08` | `标签页 轨迹量化` + `上下文统计窗口` + `Token 统计窗口` | `/api/trajectory/insights` |
| F-09 洞察页 | `F-09` | `洞察概览窗口` + `用量趋势窗口` + `会话排行窗口` | `/api/insights`、`/api/tool-stats` |
| F-10 编队页 | `F-10` | `标签页 编队` + `编队` | `/api/fleet` |
| F-11 供应商页 | `F-11` | `供应商窗口` | `/api/providers`、`/api/providers/magpie` |
| F-12 资源页 | `F-12` | `资源库窗口` | `/api/catalog`、`/api/capabilities/config` |
| F-13 装配页 | `F-13` | `能力装配窗口` | `/api/catalog` |
| F-14 设置页 | `F-14` | `标签页 运行设置` + `运行设置` | `/api/config`、`/api/limits`、`/api/startup.mode=view` |
| F-15 托盘 | （未覆盖，见 §4） | — | — |
| F-16 空态/错误态 | `F-16-empty-and-error` | 无数据下编队/资源页仍渲染面板；开头先归一化到 `标签页 白板` | `/api/health`、`/api/startup`、`/api/fleet` |

另有 6 条 rail 级 journey（`rail-insights|fleet|providers|capabilities|assemblies|settings|trajectory`）
与 `shell-workspace`，逐页验证「点侧栏 → 页签与面板真的换了 → daemon 数据可读」，并各自留 PNG。

**这套东西自己也被验证过**：
- `go test ./acceptance` 黑盒跑 `./verify-graph`，断言 help/doctor/未知命令/skill 结构/仓库边界；
- `go test ./internal/skilldoc` 断言 skill 与 Feature Map 的结构、以及**文档里写的每一条 `verify-graph <cmd>` 都真实存在**
  （命令面可由 `verify-graph help --json` 自报，所以新增命令不会让这条检查过期）；
- `go test ./internal/evidence` 断言证据三件套（assertions/summary/manifest）与 `verify`/`pack` 的行为。

---

## 3. 证据在哪

```
verification/evidence/<runId>/<feature>/          # cleanup 不删，git 不跟踪大文件除外
  assertions.json      每条断言的 id / expected / actual / evidence 路径
  summary.json         passed / failed / skippedSteps / 起止时间 / commit
  manifest.json        目录内除自身外每个文件的 sha256 + bytes
  *.png                该功能的人可复核截图（-R<窗口 bounds> 区域截图）
  check-NN.json        对应 /api/* 的请求与响应体
  result.json          渲染树文案、access[{name,role,value}]、每步 outcome
verification/.run/<runId>/                        # 运行态（cleanup 删除）
  run.json / instance.json   记录 pid、端口、state/graph-home/config 路径
  state/ graph-home/ home/ tmp/ run/ logs/       隔离三件套 + 日志 + 单实例锁目录
```

隔离铁律（每 run 一套，已实测与用户实例并存）：`GRAPH_STATE_DIR/GRAPH_CONFIG/GRAPH_HOME` 指向 `.run/<id>`，
`HOME/TMPDIR/XDG_RUNTIME_DIR` 重定向，`PATH` 首位放 `launchctl` 影子（exit 1，记录调用），窗口用
`-X mygo.packageIdentifier=dev.graph.verify.<id>` 改名。`cleanup` 只杀 `run.json` 记账且 `ps` 身份核对过的 pid。

---

## 4. 已知限制（不粉饰）

1. **F-04 对话渲染、F-15 托盘没有 journey。** F-04 现在有可行工具（`launch --mode execute --seed` 起本地替身模型，
   会话会得到真的 assistant turn、轨迹记录 input/output token），但没有写成 journey：收敛阶段停止扩展，所以它仍是空白；
   补的时候要断言「消息流出现该 assistant 文本 + `/trajectory` 记到请求与 token」，不要断言「页面能打开」。
   F-15 在菜单栏 surface，headless 车道看不见，要走窗口/系统 surface 车道。
2. **窗口车道的多步连续驱动还残。** `ui window open` 把 appPid 写进 `instance.json`，而 `ui window click|shot` 读
   `run.json`（那里 appPid 为 null），于是 open 成功后 click 报 `this run has no window process`（窗口其实活着）。
   修法：两个命令读同一份记录。窗口车道现在只适合单步取证，不适合「点五次」的长journey。
3. **`checks[].expect` 是深相等，不是子集匹配。** 写 `{"stats":{"agents":0}}` 会因为同时要求
   `cost/tokens/messages` 相等而判红——而那正是 AGENTS.md 禁止的「比随调度变化的字段」。
   现在只能对稳定响应用 `expect`，其余只写 `expectStatus`；建议改成子集递归匹配，另留 `expectExact`。
4. **截图必须带区域。** 本机 `screencapture -x <path>` 在 launchd 后台会话里返回
   `could not create image from display`，`-x -R<x>,<y>,<w>,<h>` 才成功；窗口被别的 App 遮住时 PNG 拍到的是那个 App，
   `ui motion shot` 会检查前台 pid 并拒绝把这种图当证据。
5. **`launchd` 是全局共享资源。** App 的 daemon 监督会用 `bootout/bootstrap gui/<uid>/dev.graph.daemon`，
   label 全局唯一。不装影子时，一个验证窗口就能把用户正在用的 Graph 顶掉（本轮真的发生过一次，已恢复）。
   所以 `launchctl` 影子不是可选项，`doctor` 必须能证明它生效。
6. **孤儿 daemon 只报不清。** `status`/`doctor` 会列出 `.run/` 下没有活 run 记录的 graphd（目前 7 个历史遗留），
   但按规则不按名字杀进程，`cleanup --orphans` 还没实现。
7. **headless 车道与真实窗口车道不是同一件事。** headless 走 `go test -overlay` 注入 `app` 包里的真实
   `shellState.view`，证明「渲染逻辑 + 交互状态机」对，但证明不了「真窗口里点得到」；后者要 `ui window|motion`
   或 `ui snapshot`。两边的断言文案必须各自实测过再写。

---

## 5. 四条驱动车道（选哪条看你要证明什么）

| 车道 | 命令 | 证明什么 | 前提 |
| --- | --- | --- | --- |
| daemon/API | `api GET|POST`、`scenario` 的 `checks` | 服务端契约、状态迁移 | 只要 daemon |
| headless 渲染 | `verify --journey X`、`ui render X` | 真实 `app` 视图代码的渲染与交互状态机 | 无需窗口/权限 |
| 真窗口 AX | `ui snapshot`、`ui window open|click|shot|close` | 用户真的点得到、点完真的变（含 PNG） | 辅助功能授权 |
| 自动化 socket | `ui motion open|tree|press|shot|global|close` | 应用自身驱动的精确交互 + 用户状态指纹 | 独立构建的窗口 |

---

## 6. 加一个新功能怎么接

1. 在 `skills/verify-graph/features/` 写 `F-XX-*.md`，四个 H2 固定：
   `Sub-features` / `How to get to it (user POV)` / `Driving it with verify-graph` / `Gotchas`；
2. 在 `features/index.json` 加一条（`id`、`file`、`command`、`evidence`、`api`、`measured`）；
3. 写 `scenarios/F-XX.json`：`prepare`（造前置数据）→ `steps`（`click`/`waitText`/`assertText`/`assertAccess`/`screenshot`）
   → `checks`（API 回读）；
4. `./verify-graph verify --journey F-XX` 跑通，把实际文案与坑写进 `Gotchas`；
5. `go test ./internal/skilldoc` 会检查文档结构与命令真实性（写不存在的命令会红）。
