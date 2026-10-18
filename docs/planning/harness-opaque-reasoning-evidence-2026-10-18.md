# 不透明推理块：本地连续性补充证据

本轮验证现有行为，没有修改runtime、模型、effort、默认值或待运行实验。0次付费调用；本地受控供应商产生4个主请求。整体每完成任务降本仍未证明。

## 适用范围

当前Graph ModelApi与controlled transport支持openai-completions、anthropic-messages。此前完整交付E2E已核对main/worker/reviewer的OpenAI completions reasoning_content，含main跨draft/confirmation operation；它不能代替不透明字段的传递证据。

[OpenAI官方reasoning文档](https://developers.openai.com/api/docs/guides/reasoning)说明Responses stateless返回的encrypted_content可在后续请求回传。当前Graph没有启用Responses传输，本次没有添加传输、更换模型或把其他供应商data当成该字段验证。

[Anthropic官方extended thinking文档](https://platform.claude.com/docs/en/build-with-claude/extended-thinking)要求工具对话中的thinking签名与redacted_thinking原样回传，不解析不透明数据。已安装Pi AI 0.86.1有对应接收、持久消息表示和发送分支；静态分支存在只是调查入口，下面通过公开入口核对实际wire。

## 实际本地流程

真实HTTP conversation → Pi → 本地受控Anthropic SSE → 原生bash写proof.txt → 工具回执 → 主会话正常结束 → daemon关闭重启 → 同一conversation调用原生read → 主会话再次正常结束。

外部服务返回一条thinking块，signature通过两个signature_delta发送；另有一条redacted_thinking不透明data。核对后续三个真实provider请求的assistant blocks：thinking正文、拼接后的signature及redacted data逐字不变，块类型和顺序保持。重启后实际read回执包含原文件内容，文件由真实bash写入；未替代自有组件或伪造落盘、工具回执、会话恢复结果。

探针 `/tmp/graph-anthropic-continuity-probe.mts`；证据目录 `/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-anthropic-continuity-Wygh8N`，含wire.json、verification.json、interpretation.md。只保留合成fixture的wire，文件0600，不是生产用户推理。主会话、工具往返、SQLite和重启均真实；仅外部供应商被本地服务替代，符合仅允许E2E的规则。

没有观察到丢失，所以没有宣称修复前红灯或新增生产修复。此补充没有复制到仓库新测试层或改变既有keeper；它证明当前机器该路径可用，不能声称长期门禁已覆盖。

## 仍未证明

- 本地opaque/signature是合成fixture，不能验证真实供应商加密签名接受或服务端完整语义。
- 未覆盖Anthropic resident worker/reviewer、compaction或配置rebind后的连续性，以及实际丢失告警。
- SDK对缺失签名的兼容降级不等于宿主已有丢失告警，不能把静态fallback当完成证据。
- 没有真实模型任务质量、请求数或价格收益结论；不能套用其他团队30%性能差异。

本地探针与获批shell对照隔离执行，没有改动其冻结源码、配置、helper或范围。shell对照的失败不会被本地受控推理回传成功抵消。
