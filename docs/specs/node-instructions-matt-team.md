# 节点执行指令与可复用 Matt 团队

## Problem Statement

main 在节点定义中只能填写简短 task 和验收，难以区分任务摘要与真正交给节点执行的工作指令。worker 需要明确读取 planner 发布的 plan，按计划实现，并知道何时使用哪些 skills。仅在会话中口头说明会丢失跨节点上下文；仅提到 skill 名称也不能证明节点已经绑定并能够读取该能力。

现有 Matt 配方只有实现、审查和合流角色，不能直接提供从规划到实现、独立审查及原节点返工的可复用团队。使用者要求以 ask-matt 选择流程，并采用 writing-for-agents 编写节点任务与基本要求。

## Solution

节点增加独立的 instructions 文本参数，由 main 编写执行步骤、上下文指针、上游成果使用要求、skills 触发条件以及可判断的完成标准。task 继续用于简短摘要，acceptance 与 submission 继续承担正式验收与必需输出约束。instructions 是节点任务配置，不修改配方身份，也不授予工具或能力。

提供可复用的 Matt 团队模板及其配方装配说明。main 位于 graph 外，以 ask-matt 选择适合需求的流程，以 writing-for-agents 为具体任务填写指令。graph 内 planner 发布可追踪 plan，worker 根据精确 plan 产物实现，独立 reviewer 对实际实现版本进行 Standards 与 Spec 审查。审查不通过向原 worker 投递返工意见；通过后把结果返回 main，由 main 完成集成与正式验收。确实发生 Git 冲突时才使用合流角色。

## User Stories

1. 作为 main，我能分别填写节点任务摘要和完整执行指令，使节点明确工作范围与完成条件。
2. 作为 main，我能在指令中指定 worker 读取 planner 的 plan，使实现依据经过规划的成果。
3. 作为节点，我能收到完整 instructions，而其他节点在概览中的摘要保持简洁。
4. 作为 main，我能在原 graph 中修改 instructions，使下一轮工作采用更新要求。
5. 作为使用者，我能查看节点实际收到的指令，并区分历史执行与下一轮配置。
6. 作为使用者，我能继续读取并运行已有未声明 instructions 的 graph。
7. 作为 main，我能复用 Matt 团队，为新任务替换任务摘要和指令，而不重复手工拼接整支团队。
8. 作为 planner，我使用已绑定的规划 skills 发布 plan，并携带不可变产物引用交给 worker。
9. 作为 worker，我使用已绑定的实现 skills，根据 plan 完成实现和检查，再提交真实成果版本。
10. 作为 reviewer，我独立审查实际成果与 plan，给出可定位的返工意见或精确版本的通过证据。
11. 作为 worker，我能在原会话与原累计额度下处理返工，不创建第二个 graph。
12. 作为 main，我能识别模板所需 skill 缺失或配方未编译的问题，避免派发无法履行要求的节点。

## Implementation Decisions

- instructions 为节点定义中的非空字符串。为兼容现存定义，允许历史定义省略；main 创建新节点时必须填写。声明空白或错误类型时拒绝，使用现有定义解析及整体 patch 校验。
- 指令属于 graph 修订与 execution 冻结配置。首次说明包包含本节点完整指令；配置修改在后续 execution 的现有配置更新消息中生效。正在执行和重试中的轮次继续使用冻结配置。
- 复用现有图定义持久化、节点上下文与 prompt 查看入口，不建立另一套指令存储，也不把任务指令注入配方身份。
- skill 名称是阅读和执行的上下文指针。有效能力仍由版本化配方装配决定；模板使用实际存在的能力资源，并核对发布版本。允许 main 按任务选取额外已存在 skills。
- 团队模板复用 v2 JSON 定义及子 graph 模板机制，不引入新的团队执行内核。提供可保存、按任务调整并交给 main 使用的模板和装配入口。
- main 使用 ask-matt 与 writing-for-agents；planner 负责规划，worker 负责依 plan 实现，reviewer 使用 code-review。角色配方按职责绑定 Matt skills，不将所有 skills 无差别绑定给每个节点。
- plan 和评审通过共享产物发布，投递携带精确引用。协议、必需输出、独立审查、Git 与最终验收沿用现有机制，不能以指令文本替代正式约束。
- 审查失败沿普通返工边回到原 worker；同一功能任务保持同一个 graph。main 为后续任务复用模板时创建独立实例和共享产物范围。

## Testing Decisions

- 主验收边界是实际 graph 创建、输入投递、节点执行与 prompt 查看：main 提交的 instructions 被节点收到，修改后下一轮收到新要求，旧 execution 仍保留旧要求。
- 扩展已有图定义和真实 Pi/受控供应商执行用例；解析测试只覆盖独立的非法输入与兼容契约，不在每层重复同一场景。
- 团队验收走真实 v2 graph 与产物空间，验证 planner 的 plan 引用到达 worker、reviewer 失败后同一 worker 返工、通过结果交给 main；能力编译使用真实可用清单，不伪造已加载能力。
- 保持正式输出与审查门禁；测试不能通过预置通过状态证明团队协作完成。
- 运行聚焦回归、完整检查与应用构建。部署后核对默认应用来源与实际提供的构建。

## Out of Scope

- 自动扩权、生成第三方能力、让普通节点代替 main 创建第二个 graph。
- 强制所有历史 graph 迁移、清空节点会话或累计预算。
- 每次修改草稿产生新版本，或将动态 patch 变为新任务。
- 为本功能建设独立团队商城或新的全局模板数据库。

## Further Notes

使用者已确认团队需要可复用。writing-to-agents 对应当前本地 writing-for-agents 技能。现有 Matt implement 配方的开工门禁仍引用 implement 阶段；首次派发应采用项目 Matt 流程约定的 tickets 阶段，不能要求尚未实现的任务先具备实现提交。团队装配须核对实际配方，避免继承这一过期条件。
