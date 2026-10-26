# 已补的 Go E2E

### 已补的 Go E2E

| TS 契约来源 | Go 侧文件 | 用例 |
| --- | --- | --- |
| `tests/m5/http.test.ts` 任务面：创建、列举、读回、事件游标重连、命令通道鉴权 | `tests/e2e/go-task-http.test.ts` | 3 |
| `tests/m5/http.test.ts` 会话创建时应用模型与思考档位 | `tests/e2e/go-conversation-http.test.ts` | 2 |
| `tests/m5/http.test.ts` APP 桥接密钥生命周期 | `tests/e2e/go-app-bridge.test.ts` | 3 |
| `console/config-edge.test.ts` 热配置生效、被拒候选不落盘、撤销跨重启、损坏撤销文件 fail-closed、双凭据撤销 | `tests/e2e/go-hot-config.test.ts` | 5 |
| `tests/m5/http.test.ts` 暂停/恢复：暂停期间的消息不外发，恢复后放行，暂停跨重启保持 | `tests/e2e/go-pause-resume.test.ts` | 2 |
| `console/conversation-queue.test.ts` 队列消息取消：可撤回、同一请求不重复撤回、不存在的消息报 missing | `tests/e2e/go-conversation-queue.test.ts` | 2 |
| `e2e/rework-runtime.test.ts` 项目被移出配置后历史保留、拒绝新任务 | `tests/e2e/go-removed-project.test.ts` | 1 |
| `console/attachments-payload.test.ts` 附件上限：文本文件进模型、超限被拒不落库、不支持的类型被指名拒绝 | `tests/e2e/go-attachments.test.ts` | 3 |
| `tests/m5/http.test.ts` APP 桥接 RSI 重启队列：无令牌拒绝、队列形状、畸形 ack 拒绝、未知 id 不清空 | `tests/e2e/go-rsi-bridge.test.ts` | 2 |
| `tests/e2e/rsi-shape.test.ts` RSI 真实应用：10 种错误形状被指名拒绝、真实 Git 提交、检查通过、无提交时如实报告、重载请求落地 | `tests/e2e/go-rsi-apply.test.ts` | 3 |
| `tests/m5/graph.test.ts` 图布局几何：盒子在网格上、盒子尺寸合法、走线正交且首尾落在节点边界、走线不穿过节点、同源同目标的边各走各的通道、重画后仍是可画的图 | `tests/e2e/go-graph-layout.test.ts` | 1 |
| `tests/m5/graph.test.ts` 嵌套子图：容器与成员都被画出来、回边落在成员而不是容器上、加节点不动原有节点、删节点后原有节点仍不动 | `tests/e2e/go-graph-nested.test.ts` | 3 |
| `tests/m8/credentials.test.ts` 凭据隔离：两个端点各自只拿到自己的密钥、换模型不会串钥；凭据被撤销后模型不再触达 provider；新任务记下当时生效的配置版本 | `tests/e2e/go-credentials.test.ts` | 3 |
| `tests/m8/startup.test.ts` 启动契约：无效参数/缺控制台/缺配置/缺模型/缺凭据/端口占用/状态目录被占各自报明确错误码；view-only 起得来且不派发；重建控制台不用重启；种子并编译 main 配方；重启保留任务；CLI 打印地址并干净退出；配置拒绝未知引用且相对项目根被解析；密钥只来自被指名的环境变量 | `tests/e2e/go-startup.test.ts` | 10 |
| `tests/m8/provider-headers.test.ts` 模型请求头与凭据隔离：配置的头到达 provider；opencode-go 的路由头在连接测试与真实派发都在；一个解析不出凭据的模型只禁用自己的模型；派发被关掉时建的任务在下一次 execute 启动时救回来 | `tests/e2e/go-provider-headers.test.ts` | 4 |
| `tests/e2e/provider-reconciliation.test.ts` provider 对账证据：关联头即 invocation id；每次尝试留下 fetch_started/response_headers/transport_error 三相证据；请求体的 sha256 与 provider 收到的一致；provider 没答话时不编造用量、不定价；证据里没有密钥 | `tests/e2e/go-provider-reconciliation.test.ts` | 4 |
| `tests/console/price-snapshot.test.ts` 价格刷新：验证失败保留旧金额并标 stale；验证通过重新盖戳且下一次派发冻结新版本 | `tests/e2e/go-price-snapshot.test.ts` | 2 |
| Go 侧自有契约：局部补丁对后来那次提交的路由、过期修订不生效、坏补丁被拒、已受理的活在删边后仍然活着 | `tests/e2e/go-graph-patch.test.ts` | 1 |
| Go 侧自有契约：节点 id 是字面文本（`bracket[1]` / `star*` / `question?`）；已提交过的产出不能再被重试花掉 | `tests/e2e/go-graph-node-identity.test.ts` | 1 |
| `tests/e2e/graph-definitions.test.ts` 定义整体被拒并点名规则；接收协议真的约束值且好值原样通过 | `tests/e2e/go-graph-definitions.test.ts` | 2 |
| `tests/e2e/graph-modules.test.ts` 路由级联与顺序；规则表达式；once 模块的持有与重开 | `tests/e2e/go-graph-modules.test.ts` | 3 |
| `tests/e2e/artifact-publication.test.ts` 发布的版本不可变与 CAS；越界路径与符号链接被拒 | `tests/e2e/go-artifact-publication.test.ts` | 2 |
| `tests/e2e/graph-confirmation.test.ts` 确认后的草稿画得出来、图真的跑起来；旧形状草稿变不成功能 | `tests/e2e/go-graph-confirmation.test.ts` | 2 |
| `tests/e2e/providers.test.ts` provider 目录与探针：目录不泄密钥、探针说厂商协议、拒绝保留厂商原话、坏草稿按字段被拒 | `tests/e2e/go-provider-directory.test.ts` | 4 |
| `tests/e2e/catalog-tool-loading.test.ts` 目录面按需装载、装载之后真的执行、重启之后仍然可用 | `tests/e2e/go-catalog-tools.test.ts` | 2 |
| `tests/e2e/secret-lifecycle.test.ts` 特权密钥桥接：写入等桌面端存、最新一次写入算数、浏览器看不到值、登出是一次删除、迟到的确认不许把密钥复活 | `tests/e2e/go-secret-lifecycle.test.ts` | 1 |
| `tests/m8/credentials.test.ts` 没有可解析凭据的模型在发出任何请求之前就被拒；一个模型都叫不动的会话被拒并说清原因、消息保留、密钥回来照跑；一个模型都叫不动的任务被问清原因、答复在理由还成立时被拒、密钥回来任务真跑 | `tests/e2e/go-credential-refusal.test.ts` | 3 |
| `tests/e2e/thinking.test.ts` 思考档位（daemon 那一半）：目录面给出模型接受哪些档位、请求被钳制到模型真能接受的那一档、会话读回落档、provider 收到同一档；没有档位的模型与不认识该字段的 provider 都不发；Anthropic 模型收到的是思考预算而不是档位名 | `tests/e2e/go-thinking.test.ts` | 3 |
| `tests/e2e/pricing.test.ts` 调用成本：有价模型报出金额与价格表、免费模型仍然点名价格表、没有费率如实说未知、旧式费率只报金额 | `tests/e2e/go-pricing.test.ts` | 1 |
| `tests/m8/recipe-compile.test.ts` 配方面：保存即编译并发布定义、相同配方复用同一版本、引用不存在的配方被拒不落盘、旧 compile 端点仍可用、改描述时定义版本前进、删除后配方文件里的它消失、配方里的内联系统提示真的到达下一次操作 | `tests/e2e/go-recipe-compile.test.ts` | 3 |
| `tests/e2e/scoped-system-capabilities.test.ts` 主 Agent 读宿主清单：整份清单真的到达模型（配置模型、配方、定义、架构、订阅、能力、上下文、应用十段）、模型据其行事（把它找到的模型 id 写进工作区）、清单里没有密钥、按段发放时每次只回那一段且与整份一致 | `tests/e2e/go-system-capabilities.test.ts` | 2 |
| `tests/m8/system-self-improvement.test.ts` 主 Agent 请宿主改自己：提案先成问题等人批准（未批准时连提议者自己也落不了地）、批准后能力真的进了资源库；全权策略下同一回合自动批准并落地；健康视图只看自己的会话 | `tests/e2e/go-system-change.test.ts` | 3 |
| `tests/e2e/harness-cost.test.ts` 成本诊断：真实会话跑完两个工具、账本里的请求数与 token 数真的对上 provider 报的数、按冻结费率算出的金额真的对上、request profile 只讲形状不讲内容（用户的话、密钥、工具输出都不在里面） | `tests/e2e/go-harness-cost.test.ts` | 1 |
| `tests/e2e/harness-cost.test.ts` 宿主注入指令的那三个开关：搜索规则只点名这次会话真的有的搜索工具、宿主不改写用户自己的规则、维护者身份是否把「项目失败」算成「harness 摩擦」、文档指针可以压缩但路径不丢 | `tests/e2e/go-agent-context.test.ts` | 5 |
| `tests/e2e/config-contracts.test.ts` 配置面：配置按用户写的样子回来、被拒的候选一个字节都不落盘、两个账号指向同一个上游模型却各自用自己的密钥；真实 CLI 以不限额默认启动并拒绝零或负的默认 | `tests/e2e/go-config-contracts.test.ts` | 2 |
| `tests/m8/tool-failure-record.test.ts` 失败的工具调用：节点记录里标了失败**而且带着原因**，不是一个只能标「失败」的布尔值 | `tests/e2e/go-tool-failure-record.test.ts` | 1 |
| `tests/e2e/command-output-preservation.test.ts` 公开的图命令：超出内联视图的字节一个不少地留在文件里（字节数与摘要对得上）、重启之后复用已结算的文件而不重跑 | `tests/e2e/go-command-output.test.ts` | 1 |
| `tests/e2e/project-branches.test.ts` 分支命名：十个任务名变成可读、安全、互不相同的 git 分支名、工作副本目录名不占用别人的路径、用户自己的仓库停在他选的分支上 | `tests/e2e/go-project-branches.test.ts` | 1 |
| `tests/console/schema-upgrade.test.ts` 升级旧安装：真的旧状态目录被就地升级（同一个文件）且历史、账目、配置都还在、升级之后的同一个数据库里跑得起原生图；v23 给旧交接重新编号；v41 的草稿与确认来源在迁移与重开之后都还在 | `tests/e2e/go-schema-upgrade.test.ts` | 4 |
| `tests/console/setup-wizard.test.ts` 浏览器轨：向导从干净起步连上一个平台、再加第二个、**保存本身不发请求** | 同文件改由 Go daemon 驱动（`tests/console/setup-wizard.test.ts`） | 1 |
| `tests/e2e/provider-metadata.test.ts` 浏览器轨：模型编辑器吃目录数据并落盘完整元数据、账号的凭据身份/名字/限额各自独立、缺密钥与坏配置被拒且不落盘 | 同文件改由 Go daemon 驱动（`tests/e2e/provider-metadata.test.ts`） | 6 |
| `tests/m8/settings-ui.test.ts` 浏览器轨：设置自动保存模型/凭据/限额且不泄密、厂商面板改账户并移除关联模型、账号切换跟着模型列表走、没有值的密钥不算已解析、厂商卡片字段可读、平台账户可改名 | 同文件改由 Go daemon 驱动（`tests/m8/settings-ui.test.ts`） | 9 |
| `tests/m8/settings-ui.test.ts` 被运行中的图占用的模型不能删：指名拒绝、节点仍 idle、图修订仍钉着那个模型、配置版本不前进；停掉那张图之后同一份改动就通过 | `tests/e2e/go-model-binding-guard.test.ts` | 1 |
| Go 侧自有契约：会话令牌属于安装而不是进程——daemon 被换掉之后，已经打开的控制台仍然能用（同一端口、同一状态目录、旧 cookie 依然有效） | `tests/e2e/go-session-across-restart.test.ts` | 1 |
| `tests/console/state-retention.test.ts` 状态回收：命令先报「会删多少」且**报告时一个字节都不动**、被要求回收时删的正是报出来的那些、任务**出生与变更**那两条事件永远留着、回收前先备份、回收之后状态目录仍然能起 daemon、对话仍然读得到 | `tests/e2e/go-state-reclaim.test.ts` | 1 |
| `tests/m2/verification.test.ts` 评审模块的生成与判断：命令写出的模块声明形状对、**已发布的代码入口不被覆盖**、坏策略在写文件之前被拒；生成的模块接进真实的图之后在真实的隔离容器里求值——必填维度失败是业务返工（`rework` 输出、评审人的话、要改的文件、未归属路径），必填输入没到齐时模块等着不动 | `tests/e2e/go-review-module.test.ts` | 1 |
| `tests/m2/matt-team.test.ts` 团队装配：**缺的每一个角色都在保存任何东西之前被点名**、一个配方都没发布、定义文件也没落地；装配成功时四个角色的配方真的进了控制台的目录、定义点名的是**已发布的版本**（同名旧配方让 worker 变成 `@2`）、已存在的定义文件不被覆盖 | `tests/e2e/go-assemble-team.test.ts` | 2 |
| `tests/e2e/command-output-preservation.test.ts` 原生 shell 的大输出：命令真的跑过、**整份输出留在磁盘上**、模型只看到紧凑视图与整份的路径、模型能真的读到中间那段、daemon 被换掉之后文件与字节都还在；不压缩时模型看到的是 shell 自己的上限而不是紧凑视图；**被压缩的结果不会被后来的命令清掉**（257 次 shell 结果之后第一个仍在） | `tests/e2e/go-native-shell-output.test.ts` | 3 |
| `tests/m3/production.test.ts` 节点泳道：worker **只写自己的工作副本**（用户项目里没有那份文件）、它被告知自己这份工作要过的检查与验收（图的其余部分不是它的事）；reviewer 被告知该发什么（`FINAL REVIEW REQUIREMENTS` + `graph.review@1` + `{commit,passed,reason}`），它发出来的报告真的让那条 review 验收通过 | `tests/e2e/go-node-lane.test.ts` | 2 |
| `tests/m8/app-shell-ux.test.ts` 浏览器轨（32 条中的 12 条）：项目选择器真的把项目加进侧边栏、Agent Markdown 真的渲染、工具活动折在答案后面、流式增量逐步显影、重试流被清掉、模型与思考档位一起被记住、收件箱保留已解决的问题、新会话斜杠菜单不越界、设置页独立成页 | 同文件的部分用例改由 Go daemon 驱动（`tests/m8/app-shell-ux.test.ts`） | 12 |

## 低层 206 个文件的孤儿契约审计（结论）

对 45 个高密度低层文件做了一次语义审计（读代码逐条核对，不靠标题匹配——标题匹配会产生 334 条误报）。结论：

| 分类 | 条数 | 处置 |
| --- | --- | --- |
| Go 已有实现，只缺 E2E 证明（`yes`） | 101 | 每条写一条 Go E2E；Go 侧实现点已在审计里指明（file:line） |
| Go 只能弱表达或不能表达（`partial`/`no`） | 16 | 先做 Go 设计决策，再决定写 E2E 还是连同 TS 实现一起退役 |
| 只有 Web 控制台面（`no`，无 Go 面） | 3 | 走浏览器 keeper 轨道，不是 Go E2E：`m8/shell-tabs-ui`、`m8/skill-slash-ui`、`m8/drawer-artifacts-ui` |
| 已被现有 Go E2E 覆盖 | 19 | 无需再写 |
| 已被 149 条 daemon 层契约清单覆盖 | 23 | 无需再写（移植前需与官方清单对账，避免重复） |

审计的重要结论：

- **Go 没有「有意丢掉」的产品行为**。101 条 `yes` 项在 Go 侧都能找到实现点；缺口全部是「没有 E2E 证明」。
- **已证明的进度**：批次 20 证明了 1 条（`node-budget` 的节点配额），批次 21 证明了 4 条（`node-queue` 整份：队列串行、重提额度、provider 真失败花掉自动重试额度、失败节点保留后来的输入），此后的批次又从这份清单里取走了图生命周期（图定义、图模块、图确认、补丁、节点 id）、目录面与密钥桥接、凭据缺口、思考档位与调用成本、Anthropic 预算、配方面（保存即编译、复用版本、内联提示到达操作）等簇。**「还剩 96 条」是批次 20 时的旧数字，已经过时**；清单剩余条数需要按当前批次重新点算（那份逐条审计结果没有落进仓库），所以在下一轮点算之前不再引用具体数字。
- **16 条 `partial`/`no` 需要设计决策**，其中值得先看的几条：
  - 「peer message pending 账本」（Go 没有等价物）：影响 `m1/execution` 的两条用量对账规则。
  - 「host check 等待真实 merge 才准入」（Go 有集成/复查机械，但没有等价准入规则）：影响 `m8/kernel-git-integration` 的两条。
  - 「plain directory 变成 Git 仓库」这一步在 Go 侧不可见：`m3/workspace-command` 的一条。
  - 「legacy `graph.verify` 适配器不能劫持原生隔离评审模块」：Go 根本没有 legacy 覆盖路径，该规则在 Go 侧是空真的——按「实现耦合」退休，不是 Go 的义务。
- **UI 半边要另找 keeper**：3 条纯控制台规则不能变成 Go E2E，它们随 Web 控制台的 TS 一起退役。

## Go 侧补齐的能力（退役过程中发现的真实缺口）

退役不是「删文件」，有三条能力在 Go 侧根本不存在或根本是坏的，补齐后才谈得上删：

1. **RSI 的 Agent 工具面没接线**（Batch 10 修掉）。Go 的 `RsiService` 一直存在（状态、重启队列、ack 都有），但 `PiAdapterRsi` 从未被构造——`apply_rsi_change` / `inspect_rsi_status` 对模型根本不存在。补的接线：`core_task_runtime.go` 新增 `piRsiChannel()`，把服务绑成 `PiAdapterRsi`；`runtime_pi_adapter.go` 在 HostTools 里按「master + full access + 有可用 checkout」三个条件暴露这两个工具，并把操作/会话身份带给收据。
