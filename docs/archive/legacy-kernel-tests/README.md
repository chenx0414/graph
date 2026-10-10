# 旧内核测试历史

这两个文件来自主仓库旧内核分支，合入 v2 时保留原始文本，供解释历史复杂图验收。
它们依赖已退役的 GraphPlan、LoopSpec、program 节点与隐式返工，不能作为当前执行测试。

当前路由、汇合与返工合同由 tests/m8/module-router.test.ts、module-runtime.test.ts、rework.test.ts 和 tests/console/design-examples.test.ts 验证；真实 Pi 和接口工具由 tests/m8/pi-native-tools.test.ts 验证。历史断言不作为当前能力证明。
