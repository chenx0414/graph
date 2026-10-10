# 规格（specs）

这条约定来自 Matt Pocock 工程流的 `/to-spec`：**一份规格一个文件**，路径固定为
`docs/specs/<slug>.md`，`<slug>` 是小写字母/数字/连字符。

- 谁来写：main Agent（前三步由 main 做：`grill-with-docs` → `to-spec` → `to-tickets`）。
- 内容要求（机械校验的最小集）：有 `# 标题`、至少一个 `## 小节`、正文 ≥ 200 字符。
- 之后：`/to-tickets` 把规格拆成 GitHub Issues，**每条 issue 都要指回这份规格**
  （正文里写 `docs/specs/<slug>.md` 或 slug）并带上分诊标签。
- 校验：`node scripts/matt-flow.mjs <slug> --stage spec|tickets|implement|review`
  （阶段用途与限制见 [Matt 流程](../agents/matt-flow.md#阶段用途与派发)）。

跨会话交接时提供规格、关联任务及已有实现提交；规格描述产品契约，任务描述执行与阻塞关系，提交提供实际改动。
