# 按实际调用模型汇总费用情景（2026-10-18）

完整绑定的真实 command 基线包含 8 次 DeepSeek completion 和 1 次免费模型 prompt_suggestion。main-operation 也可能混合模型；旧 summary 仅阻止 workflow 使用统一费率，给 main 的全部 token 套主模型价格会错误定价辅助调用。

## 修改

harness-cost 从实际 request profile 的模型身份、或节点冻结模型身份归组，新增 models 数组，保留每组 requests、互斥 billing token、unknownUsage 和 estimatedUsage。没有身份时 model=null，不猜测归属；原 task 行、未知费用、历史账单与完成口径不变。

harness-eval-summary 的统一 weights 路径现在也拒绝混合模型 main-operation。新增显式 modelWeights，按报告的 model 身份逐个指定费率，支持混合模型 workflow。模型明细请求数和各 billing token 必须与账本总数一致；旧导出缺明细时，先用真实 DB 重新导出，不从汇总主模型推断其他调用。两种权重参数互斥。

最小清单形状（model 字符串使用实际导出的身份，不从显示名推断）：

```json
{
  "groups": [{"name":"baseline","scope":"main-operation","runs":["/private/run.json"]}],
  "modelWeights": {
    "currency":"USD",
    "models":[
      {"model":"opencode-go:deepseek-v4.1-flash","perMillion":{"input":0.15,"output":0.6,"cacheRead":0.003,"cacheWrite":null}},
      {"model":"opencode-go:longcat-2.5-preview-free","perMillion":{"input":0,"output":0,"cacheRead":0,"cacheWrite":null}}
    ]
  }
}
```

仅将它当显式价格情景。缺整行费率、身份未知或有正 token 的费率为 null 时 pricingComplete=false、情景总成本和每完成任务成本均 null；零个某类 token 不需要虚构该类费率。usage 未知/估算或没有完整完成任务时，每完成任务情景成本仍 null。所有失败尝试仍进入分子。冻结账本的严格 costPerCompletedTask 不因新增公开情景而变为已知。

## 真实 E2E owner

扩展现有完整 delivery E2E：三个独立外部受控模型，真实 worktree、提交、artifact、host check、独立审查、交付。给三个身份不同的 input 价格，CLI 的完整任务费用必须符合供应商实际收到的各角色请求数及供应商 usage；缺 reviewer 费率或把正 input 价格置 null 都必须返回未知。零 cacheWrite 的 null 费率允许保留完整情景。没有 mock 自有账本、伪造持久化回执或编写低层测试。

扩展原 CLI lifecycle 表的一行：保留全部模型的快照模式，真实主模型修好 CLI，另一个低等级服务实际生成提示建议。统一费率汇总必须拒绝。最初夹具仍走简化模式，辅助模型没有被装配，不能作为该缺陷回归；改用真实快照模式后，旧实现实际接受混合模型统一费率，`/tmp/graph-mixed-main-pricing-red-final.log` 复现预期失败。逐模型 workflow 红灯 `/tmp/graph-model-pricing-red.log`；修复后 `/tmp/graph-model-pricing-green.log` 2 文件、12 测试通过。

真实 A/B 重新导出的逐模型结果见 [完整绑定对照](harness-bound-command-2026-10-18.md)。B 缺提示建议 usage，完整情景成本仍 null，验证了没有用零价或零 token 掩盖未知。该功能不证明优化或模型分层已降低成本。

最终完整 `/tmp/graph-harness-check-model-pricing.log`：`node --run check` 通过，272 文件、1,511 测试，352.92 秒，真实 FFF/browser 依赖执行、验收证据未变。检查自动将工作树 suite baseline 从 1,510 增至 1,511；该文件此前已有其他未提交变更，不整文件纳入本次提交。
