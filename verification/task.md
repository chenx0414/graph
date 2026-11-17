# 愿望：每个按钮都有证人

Graph 现在有 23 条 journey、headless 和真实窗口两条车道，但“页面能打开”不等于“每个控件真的可用”。这一轮把 UI 验证从 feature 级推进到 control 级：

**在稳定的、用户可达的 Graph UI 里，每一个可交互控件都必须有一个“证人”**：

- 不是 AX 树里“存在”；
- 而是有人真的点过、输入过、切换过、按过；
- 动作前后有可见状态变化或明确断言；
- 能指回某条 journey、某个步骤、某份证据、某条复现命令。

## 验收

1. 一条文档化命令能产出一份 **控件清单**（JSON 或 Markdown + JSON），覆盖所有稳定页面、页签、面板、菜单、托盘和输入区；清单包含控件名称/角色/location/所属 feature/状态。
2. 每个控件有且只有一种结论：
   - `covered`：有真实动作和证据；
   - `not-applicable`：有明确理由（一次性/外部系统/不可达/动态无法稳定定位等）；
   - `blocked`：有原因、现有尝试和下一步。
   不允许 `unknown` 或空结论。
3. `covered` 控件必须真的被驱动过：点击/输入/切换/按键至少一种，并断言动作后的可见结果或状态；只截图不算。
4. 新增控件的 witness 形成新的 journey 或 scenario step；`./verify-graph verify --all` 必须全绿，且覆盖数量明显高于当前 23 条 journey 的水平。
5. 需要真实窗口才能证明的控件（菜单栏、弹窗、焦点、键盘）在 `--lane window` 下也要有证据；不能只用 headless 冒充。
6. 覆盖工具本身有先红后绿的测试：清单稳定性、分类规则、缺证人检测、文档中的命令真实存在。
7. 冷启动 Agent 只读 `verification/skills/verify-graph/` 就能知道：怎么列出控件、怎么判断一个控件有没有证人、怎么补一个证人。

## 边界

- 主要只改 `verification/`；如果某个真实控件没有稳定的可访问名称，允许在 app 里做最小 accessibility label/定位修复，并配 app 测试。不要改其他产品行为。
- 不碰用户正在运行的 Graph 实例、真实 Magpie 配置/凭据、真实付费模型。
- 不 git commit；FINAL 由 captain 验收后提交。
- 不要为了覆盖数把动态/一次性控件硬编码成假 witness；不能绕过断言。
- 保留最终两次运行的证据；清理中间 `.run` 和旧 run，磁盘有限。

## 自由

清单怎么生成、怎么去重、journey 怎么组织、哪些控件算稳定、怎么覆盖动态列表、怎么在 headless/window 之间分工，都由你们决定。可以按页面/面板并行，也可以先做全量清点再补洞；但最后必须是一个可用、可维护、冷启动可读的完整交付，不是 12 套实验。

## 完成

写 `CONTROL_COVERAGE.md`（结论、命令、统计、阻塞项、怎么补新控件）和最终 `FINAL` 一行：
`CONVERGED <时间> controls <covered>/<total> + journeys <n>`
没全绿不要写 FINAL。

## 收口：门禁还没过，不要写 FINAL

captain 验收发现 `python3 scripts/check-queue.py` 和 `go -C backend run ./cmd/graphcheck all` 都失败，原因只是文件预算，6 个文件超过 5000 tokens：

- verification/internal/controls/controls.go（36 KB）
- verification/controls/coverage.json（43 KB）
- verification/controls/ledger.json（26 KB）
- verification/acceptance/acceptance_test.go（22 KB）
- verification/evidence/d67efeee/F-05/result.json（21 KB）
- verification/evidence/d67efeee/F-10/result.json（22 KB）

现在只做收口，不再扩覆盖、不再加 journey：

1. 按仓库规范拆分源码/测试；生成数据或必须保留的整份证据，用仓库允许的 `graph:allow-large-file:` 指令说明理由，不要删除证据或放宽断言。
2. `python3 scripts/check-queue.py` 与 `go -C backend run ./cmd/graphcheck all` 都必须通过。
3. 重新跑一次 `./verify-graph cover audit` 和 `./verify-graph verify --all`，保持 94/81/12/1、33 journeys 全绿。
4. 只有以上都绿，才重新写 `FINAL`；写完后停止编辑和测试，captain 会硬停。

现有 `FINAL` 已删除，不要提前恢复。
