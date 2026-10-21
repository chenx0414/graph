# ADR 0034：退役 TypeScript 后端实现

2026-10-20。后端已由 Go 承担（ADR 0032、0033），仓库里仍并存一整套 TypeScript 后端实现与它的测试。本决策确定退役路径：**先用真实 E2E 把 Go 侧缺的契约补齐，再按活跃引用删除 TypeScript 实现**；删除不得削弱门禁。

状态：2026-10-21。下面「Go 侧仍缺的能力」里的两处已在退役批次 16 补齐并各有真实 E2E 证明——`provider.transport` 传输证据面（`tests/e2e/go-provider-reconciliation.test.ts`）与确定性的价格校验口子（`tests/e2e/go-price-snapshot.test.ts`）。批次 17 又把主实例的预算契约整份搬进 Go（`tests/e2e/go-main-budget.test.ts`），并钉住了预算闸门只在非全权访问下生效这一事实——TypeScript 与 Go 在这一点上同构。批次 18 搬进会话面的回合收尾契约（`tests/e2e/go-conversation-runtime.test.ts`），并修掉了 Go 侧一个真 bug：先推理再调工具的回合会把自己的思考块覆盖掉、整回合失败。批次 19 搬进自改进的沉淀契约（`tests/e2e/go-sediment-settings.test.ts`），并修掉了另一个真 bug：沉淀开关在活配置里永远读不到。批次 20 搬进图生命周期的节点配额契约（`tests/e2e/go-node-budget.test.ts`），走的是主 Agent 图工具那条会话面路径，并修掉了两个真 bug：一张图的两个节点并行开工时 daemon 会因并发写 map 当场退出，以及 provider 调用记录因结构体缺 JSON tag 而读不出状态与预留。批次 21 整份搬进图生命周期的节点队列契约（`tests/e2e/go-node-queue.test.ts`，4 条），并修掉了同族的第三个形状 bug：队列与执行历史的分页结构体没有 JSON tag，图上排着哪些活、一次执行用掉几次重试都读不出来。批次 22 搬进图生命周期的建图请求契约（`tests/e2e/go-graph-create.test.ts`），并修掉一个更要紧的 bug：工具的拒绝理由在 daemon 与 worker 的跨进程边界上被整个丢掉，模型读到的是一句通用话术而不是拒绝它的理由。批次 23 搬进图生命周期的闸门与公开模块输入契约（`tests/e2e/go-graph-lifecycle.test.ts`，2 条），并修掉同族的形状 bug：投递与补丁的结果缺 JSON tag，模型读到的键是 `Delivery` / `Revision` 而不是 `delivery` / `revision`。批次 24 补上两条图生命周期的自有契约：局部补丁对**后来那次提交**的路由（`tests/e2e/go-graph-patch.test.ts`）——补丁落地在提交之前时，被关掉的连接真的不再送达、重新打开的连接真的送达，而基于过期修订的补丁什么也不改；以及节点 id 是**字面文本**（`tests/e2e/go-graph-node-identity.test.ts`）——带通配符字符的节点 id 不会被当成模式匹配，一次失败之后已经提交过的产出不能再被重试花掉一遍。批次 25 搬进图定义的拒绝面与协议值契约（`tests/e2e/go-graph-definitions.test.ts`，2 条），并修掉三个真 bug：显式的 null 被当成「没写」（`model: null` 这样的定义被真的建成了图）、没写额度的预算被当成不限额、以及协议 schema 只认六个关键字（声明了 `enum` / `items` / `minItems` / `additionalProperties` 的协议在 Go 侧收任何值都收）。批次 26 搬进图模块与产物发布的契约（`tests/e2e/go-graph-modules.test.ts` 3 条、`tests/e2e/go-artifact-publication.test.ts` 2 条）：路由级联与值的顺序、规则表达式、once 模块的持有与重开、发布的版本不可变与 compare-and-swap、以及越界路径与符号链接被拒。批次 27 搬进图确认的契约（`tests/e2e/go-graph-confirmation.test.ts`，2 条）：用户确认前草稿是一份**画得出来的**文档（节点、布局边、接口与协议都在），确认后创建的图真的跑起来（投递落在命名输入上，链真的走通，`a` 交回来的值顺着边送到了 `b`），同一个草稿确认两次不会叫醒 master 两次；旧形状的草案被工具自己的 schema 校验拒掉并点名缺哪个字段，确认接口回 400，且没有产生任何功能任务。这一批修掉一个真 bug：会话的草稿图**永远是空的**——`serveDraftGraph` 把提案的 `spec` 按 `map[string]any` 断言，而它是 `NativeProposal` 结构体，断言失败后控制台在确认之前看不到任何东西。批次 28 搬进 provider 目录与探针的契约（`tests/e2e/go-provider-directory.test.ts`，4 条）：目录点名每个内置厂商与它要的凭据、凭据在不在环境里如实显示、密钥一次都不进回答，没有会话的调用是 401；探针说厂商自己的协议（OpenAI 兼容与 Anthropic 两套：各自的认证头、各自的路径、各自的请求体），厂商拒绝时保留厂商自己的话，凭据解析不出来时点名那个环境变量且发出去的请求不带 authorization，坏草稿按字段被拒且一个请求都没发出去。这一批修掉另一个真 bug：**任何合法的 provider 地址都被判为非法**——`isHttpURL` 把 Go 的 `url.URL.Scheme`（不带冒号）拿去和 `"http:"` 比，于是探针面整条路都只会回 400。批次 29 搬进目录面与密钥桥接的契约（`tests/e2e/go-catalog-tools.test.ts` 2 条、`tests/e2e/go-secret-lifecycle.test.ts` 1 条）：目录面按需装载（第一次请求给的是装载工具，目录本身要等装载之后才出现在工具表里）、装载之后真的执行（回的是 daemon 自己发布的配方，回答里没有「工具找不到 / 参数校验失败」）、daemon 重启之后仍然绑定着并且照样答得出；不带参数的工具（空参数对象）也真的跑得起来；特权密钥桥接把最新一次写入留到最后确认、浏览器永远看不到值、没人声明的引用不会被排给桌面端。这一批修掉三个真 bug：**不带参数的工具整个调不动**——Go 的内容块把参数那一份字段标了 `omitempty`，空参数对象被整个丢掉，worker 侧的 SDK 判它非法（`Received arguments: undefined`），于是 `list_projects` / `list_agent_combinations` 这类工具在 Go 侧一个也调不动；**撤销之后的迟到确认会把密钥复活**——「已撤销」被误当成「没有当前值」，于是迟到的确认不判过期也不重排删除，用户已经登出的密钥又回来了；**模型发错的参数被悄悄改写成空对象**——参数值不再被窄化成对象，原样过界，于是模型收到的反馈与它真正写错的地方对得上（与 Pi SDK 一样）。批次 30 搬进「没有可用凭据时」的那条契约（`tests/e2e/go-credential-refusal.test.ts`，2 条）：图节点自己的模型没有密钥时，节点**失败**并且原因就写在时间线上（`graph.node.failed` 的 `reason` 点名那个模型），provider 一个请求都没收到——这一条在 Go 侧本来就是这样，这一批补的是证明；另一半按 2026-10-21 的定夺**补上了 Go 侧的能力缺口**：当一把密钥都解析不了时，master 节点压根不建，会话里那条用户消息修之前**永远停在 pending，没有任何原因**——现在分发闸门把原因说出来（用的正是「本轮没有启动起来」那套现成话术），**消息被保留**，于是密钥一回来它就照常跑完。批次 31 搬进思考档位与调用成本的契约（`tests/e2e/go-thinking.test.ts`、`tests/e2e/go-pricing.test.ts`），并修掉一个真 bug：**用户选的思考档位根本没有到达 provider**——受控传输把 `options["reasoning"]` 整个丢掉，请求体里从头到尾没有 `reasoning_effort`；修法是按 Pi SDK 的规则算档位、按各厂商的形状发字段、不认识这个字段的 provider 就不发，并把 PiG 内核那个声明了却从不用的档位接进 provider 桥。批次 32 补上任务面的同一个凭据缺口（`tests/e2e/go-credential-refusal.test.ts` 第 3 条）：任务跑不起来时不是无声地停着，而是留下任务、发出一个 `model_unavailable` 问题把理由说清，密钥回来时任务真的跑起来、那个问题自己关掉；顺带修掉答复路径上一处**节点不存在就会 panic** 的读取。批次 33 让 Anthropic 传输按 Pi 的规则问「思考预算」而不是档位名（`tests/e2e/go-thinking.test.ts` 第 3 条），并把 `max_tokens` 的优先级对齐 Pi（调用方给的上限优先于模型自己的上限）、把档位 `off` 对齐成「不发思考字段」。批次 34 搬进配方面的契约（`tests/e2e/go-recipe-compile.test.ts`，3 条）：保存即编译并发布定义、相同配方复用同一版本、引用不存在的配方被拒不落盘、改描述时定义版本前进、删除后配方真的从文件里消失、配方里的内联系统提示真的到达下一次操作；这一批**没有**逼出 Go 侧的真 bug——这几套语义在 Go 侧本来就成立，补的是证明。删除 TypeScript 实现本身尚未开始。

## 依据

- **两套实现已经漂移**。Go 侧 183 个文件约 80k 行，TypeScript 侧同构模块约 41k 行，两边各自演化。CI 的绿色主要由 TypeScript 实现背书，实际跑生产的是 Go，而 Go 侧只有少量 E2E——覆盖不对称，漂移抓不到。
- **没有任何一条产品行为是 Go 模型有意丢掉的**。逐条比对 35 个驱动 TypeScript daemon 的测试文件、176 条契约：`dropped-in-go` 数量为 0。空缺全部是「Go 侧还没有这条 E2E」、「这条证明写的是 TypeScript 内部实现」，或「Go 侧确实少一个能力」。
- **仓库政策要求先迁入真实 E2E 再退休旧测试**（`CODING_STANDARDS.md` 测试编写规则、`tests/AGENTS.md`、`.agents/skills/test-audit/SKILL.md`）。因此顺序不可颠倒：先补 Go keeper，再删 TypeScript 实现与其实现耦合测试。

## 退役边界：按活跃引用，而不是按目录

Go daemon 在运行时直接 spawn 六个 TypeScript 入口（`src/runtime/durable-service.ts` 等），它们承载崩溃恢复语义与图节点泳道，PiG 内核接管这两项之前不能删除。**从这六个入口出发的运行时闭包是 56 个 TypeScript 文件，必须保留**。

闭包必须同时按 **import 语句**与 **URL/路径字符串**两种引用计算：`src/runtime/durable-storage.ts` 用 `new Worker(new URL('./durable-storage-worker.ts', import.meta.url))` 拉起存储 worker，worker 再 import `durable-sqlite.ts`。只跟 import 会漏掉这两个文件，从而误判它们可删。

`src/server`、`src/core`、`src/runtime`、`src/catalog`、`src/git` 共 180 个文件的处置：

| 类别 | 数量 | 处置 |
| --- | --- | --- |
| Go 运行时闭包 | 56 | 保留，随 PiG 内核接管恢复语义后另行退役 |
| 仅前端可达 | 20 | 保留，属于浏览器侧契约 |
| 仅脚本/示例/桌面可达 | 100 | 本次删除目标，先迁移或退休这些工具 |
| 仅测试可达 | 4 | `src/server/cli.ts`（`pnpm start` 启动器）与 `src/server/go-launch.ts`（Go E2E 夹具依赖）保留 |

本次实际可删的是 **102 个模块**。

## 顺序

1. **补 Go E2E**：每条独立契约在 Go 上有一份真实 E2E（真实 `graphd` 进程 + 真实回环 HTTP + 受控 provider），证明它成立。
2. **退休 TypeScript 实现耦合测试**：证明写的是 TypeScript 内部实现（直接调用 `openTaskRuntime` / `TaskStore`、断言私有字段、手写私有表记录、注入假协作者）的测试随实现一起退役。
3. **迁移或退休 `scripts/`、`examples/` 里的 TypeScript 工具**：它们是 100 个待删模块的最后消费者。
4. **删除实现并更新门禁**：`package.json`、`tsconfig.json`、`tests/suite-baseline.json` 与文档同步落账。

## Go 侧仍缺的能力

删除 TypeScript 实现之前，Go 必须补上这两处，否则相关契约无法证明：

- **provider 传输证据**。TypeScript 侧每次 provider 尝试写一条 `provider.transport` 事件（`fetch_started` / `response_headers` / `transport_error`，带 `requestSha256`、`responseIds`、`usageRecoverableFromTransport`），并发送 `x-opencode-request-id` 关联头。Go 侧只有 `provider.request_profile`，证据面缺失。
- **确定性的价格校验口子**。`DaemonOptions.PriceVerify` 存在但 `serveDaemon` 从不设置，校验永远走归档 `sourceUrl` 的网络请求，真实 E2E 无法指向本地服务。

## 对既有决策的影响

不取代 ADR 0032 与 ADR 0033，只把「Go 拥有后端」从「实现选择」推进为「唯一实现」。ADR 0006 关于 TypeScript 作为领域内核实现语言的选择，其后端部分由本决策取代；Web 与桌面壳仍为 TypeScript，`src/web` 对 `src/core` 的投影依赖属于浏览器侧契约，不在本次删除范围。

## 计划与证据

[退役计划与覆盖矩阵](planning/ts-backend-retirement-2026-10-20.md) 记录模块清点、测试清点、逐文件覆盖矩阵、Go 侧缺口与每批交付。
