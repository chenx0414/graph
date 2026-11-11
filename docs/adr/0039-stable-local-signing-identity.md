# ADR 0039：本地自签身份，让辅助功能授权不随重建失效

日期：2026-11-11

## 状态

已接受，已实施。

## 背景

macOS 的 TCC 把授权记在被授予代码的「指定要求」（designated requirement，下称 DR）上。实测
`codesign -dr- /Applications/Graph.app` 与 `codesign -dr- ~/Library/Application Support/Graph/bin/graphd`
都报 `designated => cdhash H"f999a40c…"`：ad-hoc 签名没有可锚定的身份，DR 只能钉在内容摘要上。

于是任何一次重建都换 cdhash，已授予的辅助功能立刻失效。S8 激活（`03791ccc`）之后，`desktop`
工具第一次调用就返回 `PERM_DENIED`：守护进程、plist、端口都能自证，窗口里画了什么却断言不了。
每改一次 backend 就要请用户手动勾一次系统设置，真机验证因此断在最关键的一步。

## 决策

1. 在本机建一个自签的代码签名身份 `Graph Self-Signed`，放在**独立钥匙串**
   `~/.graph/signing/graph-signing.keychain-db`（权限 600，密码随机生成后存在同目录
   `keychain.pass`，同样 600）。钥匙串由 `scripts/signing-identity.mjs` 创建并可重复调用；
   导入后执行 `set-key-partition-list -S apple-tool:,apple:,codesign:`，让 codesign 无需任何
   弹框即可使用该密钥。全程不碰登录钥匙串。
2. 装包时用它签名：先签 `Contents/MacOS/Graph` 并显式给 `--identifier dev.graph.console`，再签
   整包，最后以 `codesign --verify --strict --deep` 作为门禁。身份不可用时回退 ad-hoc，并在
   安装输出里明确告警「下次重建后授权会丢」，安装本身不失败。
3. 目标是让 DR 变成与内容无关的形式：
   `identifier "dev.graph.console" and certificate root = H"…"`。launchd 跑的稳定副本是同一份
   字节拷贝，签名随字节一起过去，因此继承同一个 DR；重建只改 cdhash，不改 DR。

## 后果

- 辅助功能与屏幕录制授权只需勾一次，之后 `app`/`backend` 重建都不再丢。授权复核从「每次改完
  求人」变成「一次性配置」。
- 自签身份不被 Gatekeeper 信任：本机构建、无 quarantine 标记，启动不受影响（实测整包
  `codesign --verify --strict --deep` 通过，窗口照旧启动）；对外分发仍需 Apple Developer ID。
- 威胁模型：同用户的任意进程都能读到 `keychain.pass` 并以同一身份签名，从而继承 Graph 的 TCC
  授权。这不构成新的跨用户提权——这样的进程同样可以直接改写 `/Applications/Graph.app` 或
  稳定副本本身。代价换来的是自动化验证可重复。
- 证据：`tests/app/signing-identity.test.ts` 断言身份幂等复用、两个内容不同的二进制得到同一个
  DR、ad-hoc 签名被判为不稳定（`signatureIsStable` 为假）。安装输出会打印实际 DR，回执里能直接
  看到这次装的是稳定签名还是 ad-hoc。
- 演练：删除 `~/.graph/signing/graph-signing.keychain-db` 与 `keychain.pass` 后重装，会重新生成
  身份——此时 DR 改变，授权要再勾一次（每次换身份都会有这一次）。
