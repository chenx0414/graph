# 可复现的评测成本汇总

`scripts/harness-eval-summary.mjs` 读取显式比较清单、每轮真实结果及其独立 root/cost-report.json；不修改数据库、任务、模型或生产配置。每个 attempt 都进入分子，只有 taskSuccess=true、未超时、收尾完成且符合范围的样本进入成功数。scope 明确是 main-operation、worker-operation 或 workflow；确认图不等于完整 workflow，后者还要求 workflow.phase=completed。

同一真实状态目录（包含路径别名）不能被两个文件或分组重复引用。币种独立累加，不把 unspecified 加到 USD。含未知价格、未知用量或估算用量时，精确 costPerCompletedTask=null；零成功同样 null。knownCost 是原账本记录的费用小计，可能包含账本估算；必须连同 estimatedUsage/unknownUsage/unknownCost 看，不是发票或完整实际成本。

可选 weights 是明确的四类 token 情景，不是历史账单重建；缺任一费率拒绝。scenario.recordedTokenWeightTotal 仅为记录 token 的加权值；用量不完整或估算时 scenario.costPerCompletedTask=null。workflow 可能混合模型，拒绝用统一单价替它定价；必须先有逐调用模型/冻结价格归属。该工具不提供质量因果或统计保证。

## 使用

```sh
node scripts/harness-eval-summary.mjs /tmp/graph-matched-command-comparison.json
```

清单结构（runs 可相对清单目录，也可绝对路径）：

```json
{
  "groups": [
    {"name":"baseline","scope":"main-operation","runs":["/tmp/graph-matched-command-a1.json","/tmp/graph-matched-command-a2.json","/tmp/graph-matched-command-a3.json"]},
    {"name":"candidate","scope":"main-operation","runs":["/tmp/graph-matched-command-b1.json","/tmp/graph-matched-command-b2.json","/tmp/graph-matched-command-b3.json"]}
  ],
  "weights":{"currency":"USD","perMillion":{"input":0.30,"output":1.20,"cacheRead":0.006,"cacheWrite":0}}
}
```

cacheWrite=0 在此只是调用者显式定义的情景权重，不是供应商未知价格被填零。本批记录写 token 为 0。对含真实缓存写的其他任务不能照抄情景冒充计费。

## 真实 E2E

复用真实 CLI→HTTP→模型工具→shell→SQLite→成本报告→汇总 CLI 流程，不手造业务成功回执。覆盖通用 CLI 成功、写死旧次数失败、供应商缺失 usage 但任务成功、重复目录拒绝。另在真实提案确认 E2E 中覆盖 workflow 未完成与混合模型统一权重拒绝。

`/tmp/graph-eval-summary-red.log` 首次新 CLI 未实现而失败；`/tmp/graph-eval-summary-green.log` 正常/失败两项通过；缺 usage `/tmp/graph-eval-summary-missing-usage.log` 三项通过；两文件八项 `/tmp/graph-eval-summary-scopes.log` 通过。负向控制临时删除 estimatedUsage 保护，将估算写为完整成本，被 `/tmp/graph-eval-summary-estimate-negative.log` 明确捕获；原字节已恢复。完整 `/tmp/graph-harness-check-summary.log`：270 文件、1,500 测试全部通过，真实浏览器和 FFF 依赖均执行，验收证据未变化。

## 对旧探索的更严格重算

实际清单 `/tmp/graph-matched-command-comparison.json`，输出 `/tmp/graph-matched-command-reproducible-summary.json`。A 三次尝试/两次成功，含一次未知 usage，严格费用与情景每完成任务成本均为 null；B 三次成功、用量完整，记录 token 的统一权重每成功约 USD .006555048，但真实价格仍未知，精确费用仍 null。

此前“约 66.8%”只能作为记录 token 的探索信号，不能成为完整成本下降证明或启用依据。此次汇总没有运行新模型；Step 5 planner 仍待使用者批准。脚本不复活任何已拒绝候选，也不补跑失败样本。
