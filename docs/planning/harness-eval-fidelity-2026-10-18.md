# 隔离评测的配方资源保真缺口（2026-10-18）

本轮 command A/B 完成后发现，临时 graphHome 没有复用或冻结生产配方资源。已有结果和完整交付 E2E 只证明所记录的私有环境，不证明默认生产能力下的模型/flag 效果。先补齐评测保真，再做更多付费对照；不把这个问题当成再次调用已停止 Step 5 候选的授权。

## 权威证据

- 私有 parser A 的实际 read_system_capabilities 完整落盘结果：main/coder/reviewer resources 均 []；capabilities.entries=0，skill/MCP/extension/pi-extension/prompt 各 0。路径由 /var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-step5-approved-5wuh38om/parser-a.json 指向独立 state；该样本根目录为 graph-real-eval-default-0czHJH。
- 当前生产 /Users/macmini/.graph/agent-combinations.json：main 14 项、coder 6 项、reviewer 5 项资源引用。main 包含 writing-for-agents/handoff 等 skills、Context7、浏览器/窗口扩展、FFF；coder/reviewer 分别包含实现/测试/调试/审查相关 skills 与 FFF。精确引用和版本已仅以非秘密元数据保存到 /tmp/graph-eval-recipe-fidelity-2026-10-18.json。
- 当前 docs/agent/graph-v2.md 的“节点执行指令”要求 main 使用已绑定的 writing-for-agents skill，为新节点填非空 instructions 并核对节点 skills。私有环境没有该绑定；受控外部供应商可以直接提交合法旧式定义，不等于真实模型获得了相同的生产指导。

生产资源引用不等于全部资源都已成功加载，也不能据当前文件还原 10 月 16 日时的生产版本。不能仅凭缺失绑定断言它就是所有规划失败的原因；这需要修复后的独立验证。先前真实模型代码成功/失败、API token 和时间记录仍有效，结论范围应限于实际私有配置。

## 需要补齐的比较边界

1. 冻结实际 main 配方及其精确资源引用，核对必要资源能从本机可用版本加载；缺失/失效明确报告，不能偷偷退回空配方。
2. 保持工作项目、可访问范围、模型/effort、完成标准和对照顺序一致，记录实际绑定及 wire。不能为通过评测删掉生产身份/skills，也不能因复制配置就授权外部写入或消息发送。
3. 受控 E2E 要从真实资源装配和技能读取进入正式提案/交付，不只证明空资源配方可以被 scripted provider 驱动。
4. 将能力修复作为新的基线，不与旧的裸环境样本直接混算收益；模型候选、分工或完成定义的变化仍遵守原授权边界。所有现有实验继续关闭。

这是评测前提与报告范围的修正，没有更改生产配方、安装新凭据或修改模型选择。当前四类小任务与单例结果也不能替代完整用户功能任务集、整棵图成本和实际代码存留证据；总体降本目标尚未达成。
