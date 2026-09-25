# 共享扩展安装目录损坏与恢复

## 证据

Main 启动失败于 `npm install pi-agent-browser-native@^0.6.0 --legacy-peer-deps`，npm 日志实际错误为 `TypeError: Invalid Version:`。旧安装根的两个锁文件中，`recheck/node_modules/recheck-jar` 与 `recheck/node_modules/recheck-macos-arm64` 缺少版本字段；浏览器与搜索扩展的 package.json 已消失，根 package.json 只剩 MCP adapter。

Pi SDK 的临时 npm 根按 `npm-` 哈希生成，同一个 agentDir 的多个扩展共享目录。Graph 的损坏快照检查在解析完成后比较文件列表；正常更新也会改变列表。旧逻辑直接删除整个共享根，再只解析当前 source。并发的启动、资源库状态读取与更新又没有共用安装互斥。npm 日志显示搜索与浏览器安装在同一毫秒级时间段同时运行。

两个回归测试分别复现了删除其他扩展和并发进入 SDK resolver。锁文件损坏的完整历史不能仅由现有日志还原，但这两条代码路径足以造成同类共享状态破坏，必须移除。

## 修复与现场恢复

- 主回合/资源库解析不再用文件列表变化自动删除共享目录。快照与 gaps 函数保留为诊断工具；模块加载仍是最终运行验证。
- 同一 daemon 内按 canonical agentDir 排队解析、补 peer 和显式更新，失败释放队列；不同 source 也不能并发写共享根。此锁不覆盖用户在外部终端手动执行 npm。
- 在独立目录一次性安装浏览器 0.6.17、搜索 0.11.0、MCP adapter 2.37.0 与 Zod 4.6.5。新锁文件没有缺失版本条目，原失败的 npm 命令 dry-run 成功，三个扩展经真实 Pi loader 全部加载成功。
- 停止应用后备份旧目录，再替换为验证过的新目录；不在正在被读取的 node_modules 中逐个删除/重装，不改生产消息记录。

## 验证

定向测试覆盖共享目录保留、跨 source 串行、失败后释放队列，以及既有 peer/来源解析测试。执行全量 `node --run check` 后才提交运行分支。现场加载验证只证明扩展可加载，不替代真实模型回复证据。
