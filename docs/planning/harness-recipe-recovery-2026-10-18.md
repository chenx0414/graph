# 配方查询错误的可操作恢复信息

本轮针对完整资源模型对照中实际出现的工具错误，修复 get_agent_combination 的失败回执。没有新增真实模型会话、重跑已停止小集、改变模型/effort/角色或开启实验 flag；未证明每完成任务成本下降。

## 证据与接口边界

[上一轮真实轨迹](harness-bound-model-tiering-result-2026-10-18.md)中 main 对 coder@2、reviewer@2 查询详情，两次均得到 Unknown Agent combination；随后继续阅读文档与源码，180 秒内未发布 proposal。两次工具错误不是全部超时的因果解释，评测 setup 的术语混淆也已单独纠正。新错误回执修复针对所有调用者，不依赖评测 setup。

get_agent_combination 接受当前 recipe 的稳定 ID（coder/reviewer）；graph 节点的 recipe 字段使用定义版本引用（coder@2/reviewer@2）。不能将两者静默等同，否则调用者可能把当前配方误当历史定义的快照。

## 实际修改

仍先执行精确 recipe ID 查找，成功路径保持原样。查询失败时，如果输入具有正整数版本后缀且其稳定 ID 对应配方确实存在，错误携带可直接使用的调用，例如 get_agent_combination({"id":"coder"})；同时明确当前配方详情与 graph 节点定义版本的区别，声明本工具不解析历史定义。

没有对应配方时，只提供 list_agent_combinations 发现入口，不臆测候选 ID。错误状态保留，不返回成功、不自动重试、不创建配方、不自动接受其他版本。该改动只补充失败结果，不修改系统 prompt、工具声明/schema、原请求、reasoning history 或缓存前缀。回滚为撤销这一失败分支；没有状态迁移。

## 真正 E2E 证明

扩展既有 harness-workflow owner 的 frozen-explicit 行，保留 bare 与 frozen-auto 行：真实 CLI/HTTP、Pi、资源快照、磁盘 SQLite、Git worktree、提交、immutable artifact、host check、独立 reviewer 和目标 parser 行为验收。

受控外部模型先分别发送 coder@2、reviewer@2；下一次请求从实际工具错误内容提取 JSON 参数，真正查询稳定 ID。断言错误仍包含原错误身份、恢复结果来自实际配方（Snapshot coder/reviewer），随后继续正式 graph 交付。没有伪造宿主回复或新增测试专用生产 seam。

修复前 `/tmp/graph-recipe-recovery-red.log`：恢复查询仍报错，无法解析为真实配方，测试失败。修复后 `/tmp/graph-recipe-recovery-green.log`：1 文件/5 测试通过，50.44 秒；全部模型请求继续进入整棵任务账本，受控模型额外恢复轮次没有被排除。未新增或修改低层测试。

## 限制和下一步

受控模型按回执执行只能证明可恢复信息正确，不能证明真实模型一定读取提示，也不能据此将真实 180 秒失败标为通过。普通不存在 ID 的发现提示属于错误信息，不保证候选搜索质量。历史定义内容仍需其正式入口，当前配方不能用作历史版本证据。

当前整体目标仍未完成。后续机会应继续按实测开销和质量风险排序；广泛文档/源码探索的成本不能只靠这两个错误解释，也不能为了减少探索而禁止模型核对 API 或弱化验收。真实模型比较仍须新的具体范围，不能使用本地恢复验证绕过已触发的停止条件。

最终全量 `/tmp/graph-recipe-recovery-check.log`：272 文件、1,514 测试通过，351.19 秒；suite baseline 匹配，验收证据不变。
