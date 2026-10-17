# 评测 SDK 安装缓存与真实工具验证（2026-10-18）

本轮补齐本地 SDK 安装缓存，未调用付费模型、改写生产配方或升级生产安装包。完整生产运行依赖仍未全部证明，不能据此宣布降本或开启优化。

## 为什么目录版本不够

当前能力清单的 FFF / browser 引用仍显示 0.10.6 / 0.6.13，但共享 SDK 缓存的真实 package.json 是 0.11.0 / 0.6.17。capability-select.ts 明确规定 source 型资源的引用版本不是 pin；capabilities.ts 使用 SDK 解析 source，再同步目录版本。不能拿声明版本当实际代码版本。

当前 3 个 npm source：FFF `>=0.10.6 <0.12.0`、browser `^0.6.0`、mcp-adapter `^2.37.0`。SDK package-manager 的临时 npm 根键不依赖工作项目；其 installedNpmMatchesConfiguredVersion 使用 semver satisfies，已有匹配包正常复用，不应仅凭“范围”断言每次都会下载新版本。显式更新、缺失包及 peer 修复仍是独立变动来源。

历史生产实例没有可用 loadedExtensions 记录，故本轮只证明当前缓存与私有解析，不声称还原过去正在执行的包字节。

## 私有解析与执行

复制共享 extensions 缓存到私有目录（COW），不在真实缓存中执行安装/更新。先用本地包路径，再以原始 3 个 npm range 交给实际 resolvePiExtensionSource，解析出：

| 包 | 实际解析版本 |
| --- | --- |
| @ff-labs/pi-fff | 0.11.0 |
| pi-agent-browser-native | 0.6.17 |
| pi-mcp-adapter | 2.38.0 |

原始范围解析显式使用 PI_OFFLINE=1、npm_config_offline=true；package-lock 前后 SHA-256 相同：ce35614588ad98b4227665f8d0e2970b78768737c7056ea52979bbb06df2f54a。结果在 /tmp/graph-private-package-ranges-2026-10-18.json。本地路径探针为 /tmp/graph-private-package-probe-2026-10-18.json。它们不等于 OS 网络隔离或 MCP 服务可用性证明。

以这份私有缓存作为原有真实 FFF/browser E2E 的 source，2 文件/12 测试全部通过（/tmp/graph-private-packages-e2e.log）：实际 FFF 文件查询、浏览器访问真实本地 HTTP 页面读取 title、发现/重启路径都走原组件，不用替代扩展提供结果。语言模型供应商为受控外部服务，不产生付费模型调用；浏览器仍使用宿主已安装的 CLI/浏览器，尚未封装全部宿主依赖。

## 快照修复与回归

harness-eval-context 现在复制并校验 extensions，与 capabilities、prompts、完整配方一起进入摘要。manifest 和 runner 报告 packageCacheIncluded；旧快照未含缓存时仍明确 false，不伪装为完整依赖已经冻结。源范围声明保持原样，没有为了通过评测替换用户的 package source 或版本选择规则。

在原 CLI/Pi E2E owner 中，模型从实际绑定 skill 路径找到私有 graphHome，随后用真实 Node CLI 执行缓存内的代码。冻结后改写源缓存，执行仍必须输出冻结版本，再完成 parser 修复。修复前 /tmp/graph-context-cache-red.log 因缓存代码未复制而找不到模块；完整门禁中修复后用例通过。没有创建测试专用生产 hook。

新本机快照：/var/folders/dk/tj7mg4qn2xz3zm_z_0lxnp4r0000gn/T/graph-context-with-cache-7WU3ly/snapshot。11 配方、377 目录、143,901 普通文件，packageCacheIncluded=true；源/副本摘要 de57b345f76ce241c037d3eb2c3ca873372a1ee026d573c32e194fdde5034b39，模型调用数 0。核对记录 /tmp/graph-context-with-cache-2026-10-18.json。此前 123,904 文件的快照保留为旧产物，不事后改写成含缓存样本。

完整门禁 /tmp/graph-harness-check-context-cache.log：272 文件、1,510 测试全部通过，使用私有缓存的真实 FFF/browser 依赖，验收证据未变化。

仍需在完整真实角色装配中证明 MCP 初始化、实际 active tools / loaded entries、宿主命令依赖及加载时是否改动解析树；不能把单包工具成功外推为 main 的所有 14 项绑定或整棵业务任务已完成。allRuntimeDependenciesProven 继续 false。先补齐该前提，再做有代表性的完整任务成本对照。
