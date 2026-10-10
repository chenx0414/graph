# Matt harness 维护

本项目的工程入口由 [AGENTS.md](../../AGENTS.md)按工作阶段路由到 [CODING_STANDARDS.md](../../CODING_STANDARDS.md)。用户使用 `/ask-matt` 选择技能；规格与任务的项目契约见 [Matt 流程](matt-flow.md)。

## 来源与配置

| 内容 | 权威位置 | 何时读取 |
| --- | --- | --- |
| 工程规则 | `CODING_STANDARDS.md` | 探索、实施、审查及提交或推送前 |
| 领域语言与决策 | `CONTEXT.md`、`docs/adr/` | 按工程规则读取相关区域 |
| 任务平台 | [issue-tracker.md](issue-tracker.md) | 操作 GitHub 任务或 PR 前 |
| 分诊标签 | [triage-labels.md](triage-labels.md) | 分诊或修改分诊标签前 |
| 检查操作 | [checks.md](checks.md) | 准备测试环境、更新证据或排障时 |
| 技能与来源锁定 | `.agents/skills/`、`.agents/matt-skills-lock.json` | 更新技能或排查路由时 |

`.agents/skills/`、来源锁文件和许可证纳入版本管理，并随 App 源码打包；其他本地 `.agents/` 内容继续忽略。技能变更提交后可随 clone 或更新获得。共享工程文档不依赖技能才能读取；运行中的会话与已发布 Agent 配方仍需按各自生命周期加载更新。

## 更新技能

1. 读取本地锁文件，确认上游仓库、固定 commit、已安装清单及 `local_adaptations`。
2. 核对上游目标提交。已有版本相同时保留原锁定；有变化时先比较差异，再更新相应技能及其引用文件。
3. 保留项目适配：`CONTEXT.md` 命名、GitHub 工作约定、Codex 会话检索、工程规范读取阶段及项目自有技能。setup 重跑时更新缺失配置，沿用已确认的入口、平台和标签选择。
4. 核对 frontmatter、引用路径、调用方式和实际使用场景；技能编写参考 `/writing-for-agents`。完成后记录来源与本地适配。某个校验器不支持上游字段时，保留原调用策略并单独验证该字段，不能为了校验通过改变技能行为。

`node --run skills:lint` 默认检查 Graph 自行创建的技能，是辅助提示；结果不能证明全部上游技能或工作流已验证。完整仓库检查要求仍以工程规范为准。

## 工程 harness 与运行应用

本地 `.agents/skills/` 服务于编码 Agent。Graph 应用中的能力库、Agent 配方与已发布版本由运行应用管理，修改本地技能不会自动重绑已有节点。

编写或修订运行中的 graph 时，读取正在运行的应用提供的接口与文档路径，并核对其源码身份；工作目录里的文档可能属于不同内核版本。v2 的产品契约见 [重构规格](../specs/graph-rebuild-v2.md)，实际可调用能力以宿主提供的接口为准。

## 回溯与调整

使用 `/retro` 回溯具体会话；会话读取方法见 [检查操作指南](checks.md#会话回溯)。确定性的错误优先修复机械检查，判断规则集中于工程规范，导航问题修正触发指针。旧 `domain.md` 保留为迁移入口，历史验收文档保留当时的结论。
