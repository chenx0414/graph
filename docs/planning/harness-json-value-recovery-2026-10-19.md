# JSON 原生对象误传为字符串的诊断

## 实际问题与范围

[600秒shell对照](harness-shell-workflow-result-2026-10-18.md)的B组两次发送 `graph_send.value="{}"` 或 `"{\"round\":1}"`，而work.job要求对象。宿主拒绝后，模型把问题归因于工具schema只能传字符串，继续查源码并尝试把graph_patch.changes也序列化为字符串；收到的却是泛化“缺少reason”。最终没有任何节点执行，main到600秒被中断。

只读时间线进一步核对：第一次graph_send类型错误之后仍有26条实际请求profile，到main被中断共323097ms；这些是错误后的完整轨迹，不是错误独占成本或可移除份额。证据 `/tmp/graph-json-value-recovery-tail.json`。

A组原生对象调用已成功，B的实际工具清单也包含graph_send/graph_patch。因此证据支持参数类型误用与诊断不足，不支持“SDK只能传字符串”或“工具未加载”。不能把全部337599ms第二operation或所有额外请求算成本修复可节省的成本，也不能把失败全部归因shell短视图。

## 修改

`interface-spec.ts`保留协议验证和原错误路径。在协议根类型明确为object、首个错误确为根type/object错误、实际值为string时，追加“收到字符串，应直接传JSON对象，而非JSON编码字符串”的诊断。其他根类型、嵌套路径或验证结果保持原路径；先做原验证，通过的值不进入诊断分支。没有JSON.parse、值转换或协议改写，也不把复杂schema的第一个分支错误冒充唯一预期类型。

`graph-runtime.ts`在检查graph归属、生命周期、baseRevision之后，先拒绝非对象的changes，再检查reason、patch/definition与原验收约束。错误直接说明changes须为JSON对象，避免让字符串中的reason字段看起来“缺失”。合法对象缺reason仍是原错误。拒绝路径不创建revision、投递、队列或副作用。

系统prompt逐行处置：无改动；工具schema/description、模型、effort、分工、重试、输出限制和实验默认不变。新增说明只在对应错误发生时返回，不给所有正常请求添加常驻提示。回滚只撤销这两处诊断分支，不迁移或改写数据。

## 真实E2E证据

按diagnosing-bugs与test-audit扩展现有 `tests/e2e/harness-workflow.test.ts` 的frozen-explicit行，未新增单元、集成或重复测试层。真实CLI、Pi、工具、SQLite、router、worktree提交、宿主检查、独立当前commit审查、artifact与目标业务交付全部执行，仅外部供应商使用本地受控服务。

该行重放字符串changes和值；受控外部服务观察RuntimeError后，以原生对象重试。断言新错误明确解释JSON编码字符串、正确patch仍能基于revision1生成revision2；原对象输入只产生原有work/review两次execution，失败不产生额外执行。随后完整业务验收通过。这个受控服务的纠正不证明真实模型一定会遵循新诊断。

同一完整流程另有合法string协议的router，将JSON形状文本 `{"keep":"literal"}` 通过正式graph_send、router与公开结果原样传递。最终graph_inspect读取持久结果，断言仍为原字符串，防止为了修复对象误用而默默解析所有字符串。其他bare/frozen-auto行继续走原路径，原角色、推理连续性、计量和交付断言保留。

- 精确修复前红灯：`VITEST_MAX_WORKERS=4 npm_config_offline=true node --run test -- tests/e2e/harness-workflow.test.ts -t 'context=frozen-explicit'`，8.86秒，业务恢复后完成，但新诊断缺失的断言失败；`/tmp/graph-json-value-red-final.log`。更早的39.09秒探针故意不恢复，导致未派发work后审查夹具读空artifact的额外异常；保留日志，不作为精确回归证据。
- 初版修复后同文件5项通过，49.12秒；`/tmp/graph-json-value-green.log`。
- 自审将提示条件收窄为协议根type明确object后，最终定向1项通过/4未选择，8.08秒；`/tmp/graph-json-value-final-focused.log`。正常字符串路径的同一owner在该行中通过。

最终 `node --run check` 全量通过：272文件、1514测试，351.39秒；baseline匹配、验收证据不变。日志 `/tmp/graph-json-value-check.log`。无调试日志或生产测试注入接口；静态自审核对了合法字符串、错误无副作用、revision/权限检查顺序与正常路径。当前没有新真实模型调用、重开旧范围或生产重启。

这是原目标允许直接修复的重复工具错误。潜在价值是减少错误归因后的探索，尚无真实整任务请求/费用收益、模型质量等效或线上效果证据，整体目标不因此标记完成。
