# C03 旧 schema 全链路升级 — 交付报告

- 提交：`8ca4383`。夹具由**历史代码**生成：`git archive 8cd1523`(v13) / `790af5e`(v17) 后运行当时的 `TaskStore` 建库并写入真实行；`tests/fixtures/legacy/provenance.json` 记录来源与创建命令。
- 测试：`tests/console/schema-upgrade.test.ts`（v13、v17 各一条）在**同一文件**上升级到 v19：`budget=20000000`、`used=12345`、`unlimited=0`、invocation cost 原样；旧任务视图可读；热保存配置 `applied:true`；非 Git 目录完成基线提交（`graph: local baseline`）；脚本工人 + 检查节点跑通并写 node_entries；inode 不变（未删库）。
- 限制：未覆盖 v0–v12 夹具（迁移链在既有单测中覆盖）。
