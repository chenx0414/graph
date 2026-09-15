# C04 打包 Electron 贯通 — 交付报告

- 提交：`d99ee4f`（前序 IPC/文案修复见该提交）。
- 打包：`node --run app:build` → `/Users/macmini/workspace/graph-unified-dev/dist/app/mac-arm64/Graph.app`（runtime/node 为真实 Node 24.20.0，helper 在沙箱内使用它；Electron 二进制无法在沙箱中加载 Helper app）。
- 自动化：`docs/planning/acceptance-evidence/unified-console-closeout/c04/app-e2e.mjs`，结果 `c04-result.json`（8/8 PASS）。真实成品 APP 经 CDP 驱动 UI：
  1) 首次运行向导选自定义平台、填 key → `safeStorage` 加密写 `secrets.json`（无明文）且经 `POST /api/app/secret` 热生效（`已保存并应用（revision 1）`）；
  2) 对话 → 绑定项目 → 草稿 V1 → 确认，创建任务；
  3) 工人节点详情有真实 Pi 条目（`worker finished the packaged-app task`，16 tokens）；
  4) 非 Git 目录由宿主初始化并提交 `graph: local baseline`；
  5) 人才经历出现 1 条完整样本；
  6) 设置页保存（revision 2，`已应用到当前守护进程`）**daemon PID 42903 前后一致**，未 relaunch。
- 代码修复：`graph:save-secret` 支持 `null` 撤销（`applySecretRequest` + 单测）；Settings 以 `applied` 判定；去除「保存后需重启」文案；沙箱 helper 读取 Electron bundle 与改用内置 node。
- 未测：真实钥匙串持久化是同一路径下的加密写盘（本机 `safeStorage` 可用、已断言无明文）；未用真实付费供应商；Electron 的代码签名/公证/升级未测。
