# pstack 角色与模型映射

**什么时候读**：用 pstack 技能（`/skill:poteto-mode` 及其 playbook）给节点分配模型、决定思考档位，或核对某个角色该跑哪个模型时。**只是选**已有配方或节点时不必读本文件。

**性质**：这是本项目对 pstack `/setup-pstack` 规则的落地记录。pstack 上游把规则写进 `~/.cursor/rules/pstack-models.mdc`，用 Cursor 的 `Task` 子代理与 Cursor 模型 slug；Graph 不用那套词汇，**本表才是实际生效的映射**。

## 预算

`# budget: large (xhigh)` —— 目标思考档位是 xhigh。

两个已配置模型在运行时都**不提供** xhigh，而且档位比厂商目录里写的更少——Graph 以 models.dev 快照（`src/catalog/models-dev.snapshot.json`）里该模型声明的 effort 取值为准：`deepseek-v4-flash` 是 `low/high/max`，`deepseek-v4-pro` 是 `high/max`。所以：

- **配置默认档位**写成 `high`（`graph.config.json` 的 `models.entries[].defaultThinkingLevel`）——按 pstack 规则「同族取不高于目标的最高档」。这与 Graph 自身的默认规则（「该模型支持档位里第二强的那个」）结果一致，所以行为没有变化，只是把预算钉住了。
- **会话里不要请求 xhigh**。请求一个模型不支持的档位时，SDK 夹到**最近的更强档**，xhigh 会被抬成 `max`，而不是按 pstack 规则落回 `high`。要在这个项目里表达「比 high 更用力」，用 `max`。
- 这两个模型的有效阶梯很短：flash 是 `low → high → max`，pro 是 `high → max`。别按七档阶梯去规划角色。

档位对**新会话**生效；单个会话可以在控制台改，会话指定的档位优先于配置默认。

## 角色表

| pstack 角色 | Graph 模型 | 用途 |
| --- | --- | --- |
| `feature, refactoring` | `deepseek-v4-pro` | 代码委派 |
| `bug-fix` | `deepseek-v4-pro` | 代码委派 |
| `perf-issue` | `deepseek-v4-pro` | 代码委派 |
| `hillclimb` | `deepseek-v4-pro` | 代码委派 |
| `judgment and prose` | `deepseek-v4-flash` | 判断与散文 |
| `hardest tasks` | `deepseek-v4-flash` | 最难的改动 |
| `how explorer` | `deepseek-v4-pro` | 读代码 |
| `how explainer` | `deepseek-v4-flash` | 写解释 |
| `why investigators` | `deepseek-v4-pro` | 查证 |
| `why synthesizer` | `deepseek-v4-flash` | 合成 |
| `reflect tooling` | `deepseek-v4-pro` | 工具视角 |
| `reflect judgment, divergent, synthesizer` | `deepseek-v4-flash` | 判断、发散与合成 |
| `arena runners` | `deepseek-v4-flash`, `deepseek-v4-pro` | 面板：每个条目一个 runner |
| `arena cross-judge pool` | `deepseek-v4-flash`, `deepseek-v4-pro` | 交叉裁判：选一个家族不同于父会话的 |
| `swarm workers` | `deepseek-v4-pro` | 并行工作节点 |
| `architect runners` | `deepseek-v4-flash`, `deepseek-v4-pro` | 面板 |
| `interrogate reviewers` | `deepseek-v4-flash`, `deepseek-v4-pro` | 面板 |

模型 id 是本项目 `graph.config.json` 里的**配置 id**，不是上游模型名，也不是 `modelId`。

## Graph 怎么真正选中模型

1. 节点定义了 `model` 就用它——前提是这个 id 在已配置条目里存在。
2. 否则取 `models.entries` 里的**第一个可用模型**（没有等级、没有偏好表）。
3. 思考档位按「会话指定的档位 > 模型的 `defaultThinkingLevel` > 该模型支持档位里第二强的那个」取值；请求的档位模型不支持时，SDK **先向上**找最近的更强档（找不到才向下），所以请求 xhigh 会得到 `max`。

所以「角色 → 模型」只落到节点的 `model` 字段；本表是写哪个模型 id 的依据。

## 与上游的差异

- 上游默认面板是 opus 5.5（判断/散文）+ grok 4.7（代码）。本项目的 opencode-go 目录里**没有** opus 5.5，已配置的两个模型又同属 deepseek 家族，因此按现有配置映射为 flash（判断）/ pro（代码）。
- 上游的 `inherit-parent` / `auto` 在 Graph 里对应「**不写** `model`」，于是用配置里的第一个模型。
- 上游的面板用「一个条目一个子代理」的 fan-out。Graph 里同一件事由不同 `model` 的多个节点承担。
- 想换家族：先在 `graph.config.json` 增加模型条目（凭据 `opencode-go`），再改本表。改完必须用 `/api/config/test` 真实调用一次验证，别只看 `applied: true`——步骤见 [模型与厂商配置](models-and-providers.md)。
- 要真正跑在 xhigh，得选**快照里声明了 xhigh** 的模型：`gpt-6-luna` 与 `gpt-5.6-luna`（`none/low/medium/high/xhigh/max`）最完整，`grok-4.7` 与 `grok-4.6` 到 xhigh 但没有 max。别按厂商目录想当然——厂商写着的档位与 Graph 实际发出的档位不是一回事。
