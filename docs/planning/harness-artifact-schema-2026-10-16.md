# Artifact schema 参数说明修正

真实命令对照 B3 在修复配置后调用 artifact_publish，收到“schema must use kind@version syntax”；随后读文档与源码并尝试 RSI 修改参数说明，最终在 120 秒截止时未结束。原始 `/tmp/graph-browser-command-b3.json` 记录独立目录，SQLite 中 message.tool 保留失败和后续动作。该尝试被工作区变更保护拒绝，没有放松保护。

运行时 parseSchema 使用既有格式 `^([a-z][a-z0-9._-]*)@([1-9]\d*)$`，而工具参数仅 Type.String。现补参数 description：kind@version、source-list@1 示例、kind 字符范围与正整数版本；不需要身份时可省略。未新增限制，未修改运行时 parser、来源权限或并发规则。这是有轨迹依据的工具错误修正，不是向模型要求少用 token。

扩展现有真实 Graph worker→供应商 HTTP→artifact_publish→持久化→读取 E2E：先错误 schema source-list/v1 被拒绝，再以 source-list@1 发布，保留标签、不可变版本、重放与 stale compare-and-swap 保护。该测试证明业务契约，不模拟模型理解能力；参数说明是否减少真实模型错误仍需真实样本，不能用受控供应商台词声称降本。

本次不为一个字符串说明增加镜像实现的单元测试。验证日志 `/tmp/graph-artifact-schema-green.log`，完整门禁 `/tmp/graph-harness-check-artifact-schema.log`：268 文件/1,489 测试通过，1 文件/2 项浏览器环境依赖测试跳过；总清单 269 文件/1,491 测试，验收证据不变。浏览器依赖本轮未提供，因此该环境依赖测试跳过；其真实执行证据在上一轮带扩展门禁。此说明增加少量静态字节，收益来自潜在减少错误与返工；目前未证明整体每完成任务费用下降。可独立撤销参数 description 恢复旧定义。

## 真实模型发布验证

固定短请求“把一份内容为 artifact schema proof 的笔记发布到 research 命名空间，名字 note，带上 schema 身份与版本。”没有在用户请求中给格式解法。相同已配置 DeepSeek V4.1 Flash high、三个优化 flag 关闭，三次独立状态。临时 `/tmp/graph-artifact-real-eval.mjs` 基于正式 runner，验收使用正式 runtime.artifacts.list/read 证明内容与 schemaKind/schemaVersion，不由供应商台词充当回执。

| 样本 | 完整成功 | 请求 | operation ms | 工具错误 |
| --- | --- | ---: | ---: | --- |
| 1 | True | 3 | 36939 | 0 |
| 2 | True | 7 | 61710 | 0 |
| 3 | True | 7 | 65963 | 0 |

原始 `/tmp/graph-artifact-schema-real-{1,2,3}.json`、`.log`，汇总 `/tmp/graph-artifact-schema-real-summary.json`，每项记录隔离目录。临时脚本沿用 parser 的 caseId 标签，但实际 prompt 与验收已替换为上述 artifact 任务；不能把这三项算 parser 验收。三次均无工具错误，不代表未修改组也会失败；没有固定前后对照，故不声称降本或质量提升。费用仍未知，保留四类 token 供以后对照。
