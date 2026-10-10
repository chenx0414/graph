# 工程规范

按当前工作阶段读取对应章节；产品规则、架构决策和操作步骤分别保留在其权威文档中。

## 探索与审查

读取根目录 [CONTEXT.md](CONTEXT.md)，使用其中的领域术语；再读取 [docs/adr/](docs/adr/) 中与本次工作相关的决策。新增领域概念时记录术语表补充项；与已有 ADR 冲突的建议须指出具体决策和冲突原因。

## 实施

实施功能前读取 [产品与执行规则](docs/graph-mvp.md)、[实现架构](docs/architecture.md)和 [实施计划](docs/implementation-plan.md)。修改按已确认的产品契约验收，阶段进度不能代替完整交付条件。

## 验证与交付

提交或推送前运行 `node --run check`；通过完整检查后再交付。

普通测试的截图写入临时目录，保持 [验收证据](docs/planning/acceptance-evidence/) 不变。明确要更新交付证据时，按 [检查操作指南](docs/agents/checks.md#验收证据)执行并审阅证据差异。

需要配置 pre-push、使用测试夹具、在工作树验证或回溯会话时，读取 [检查操作指南](docs/agents/checks.md)的对应章节。
