# Fresh 前驱交接采用逐边结果交接策略

Fresh 子 Agent 的每条 incoming 依赖边在 graph 定义时确定输入投影策略：普通实现与返工下游默认 `result_handoff`，前驱必须提交冻结的结构化 `ResultHandoff`；独立审查、验证以及无法安全推断语义的边使用或要求 `evidence_only`。容器依赖展开到实际 leaf，策略随 graph revision 和 context handoff 冻结。

## 结果

- `ResultHandoff` 绑定 source node、instance、operation、activation、outputVersion 和 operation result digest；缺失、过期、schema 或 digest 不匹配时下游失败关闭，不自动降级为仅证据。
- `evidence_only` 只投影验收、证据和 artifact refs，不投影前驱 `workSummary`、自由文本、transcript、tool history 或隐藏推理。
- 审查节点不能以 `result_handoff` 作为自己的入边；但审查结论可以作为结果交接来源，允许 review/verify 出边把紧凑结论交给返工实现。
- 返工创建新 activation 后，旧 activation 的 handoff 自动失效；新的 Fresh 下游读取新的 outputVersion。
- Fork 继续作为独立上下文模式，不承载 predecessor handoff 语义。

## 未采用

- 不把省略的 incoming 边静默解释为仅证据；无法判断语义时 proposal 必须显式声明策略。
- 不把前驱 transcript 或 tool history 注入 Fresh；需要精确会话连续性时必须选择 Fork。
- 不允许缺失 `ResultHandoff` 时读取前驱自由文本作为兜底，因为这会破坏独立性并掩盖 digest/版本错误。
