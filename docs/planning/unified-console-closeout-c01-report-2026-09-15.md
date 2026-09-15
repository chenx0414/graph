# C01 默认价格快照与刷新 — 交付报告

- 提交：`ec09456`。证据：`docs/planning/acceptance-evidence/unified-console-closeout/`。
- 实现：`src/catalog/price-snapshot.ts` 内置带 `sourceUrl`/`retrievedAt`/`catalogRevision` 的快照（Anthropic `claude-sonnet-4-5`/`claude-haiku-4-5` 取自 https://www.anthropic.com/pricing ；DeepSeek `deepseek-flash`/`deepseek-v4-pro` 取自 https://api-docs.deepseek.com/quick_start/pricing ，peak 价，cache write 以 miss 价作上界）。OpenAI/Gemini/OpenRouter 页面本环境 403/无静态表，未核实即保持 unknown（不填 0）。
- 刷新：`POST /api/pricing/refresh`（显式按钮，保存不偷拉）；成功写入新 `catalogRevision`，失败保留旧金额并标 `stale`；旧 invocation 的 cost JSON 由 `estimateCost` 冻结不变。向导显示币种/日期/来源 host。
- 测试：`tests/console/price-snapshot.test.ts`（5）；`tests/console/anthropic-transport.test.ts` 断言改为「有价必有来源」。手算对照：1M input @$3 = $3。
- 未测/限制：未调用任何计费 API；刷新为「重新核对官方页并重新盖章」，不自动抓取新数字（页面无机器可读价格表）。
