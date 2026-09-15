# U03 配置、凭据与调度器热生效：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。契约见 [ADR 0010](../adr/0010-unified-console-contracts.md)。前置 `6c0b4b8`（U02）。

## 交付内容

- **宿主 LiveConfig**（`src/server/live-config.ts`）：不可变运行快照，持有目录、按模型解析的凭据绑定（含并发身份）、master 模型、默认额度、有效 revision、`limitAliases`。`apply` 计算候选：校验（含别名同 key 的共享组冲突，合并“APP 推送密钥优先于环境变量”的视图）成功后原子替换；失败保留旧有效绑定并返回原因。`pushSecret` 支持轮换与置空（禁用）。
- **保存即应用**：`POST /api/config` 在 daemon 上依次执行原子文件保存（revision+1、冲突检查）与 `live.apply`；成功时重新注册 Pi provider、唤醒调度器、按需发布定义并启动派发循环，返回 `{revision, effectiveRevision, applied, configured}`，`restartRequired` 为 false。候选被拒时返回 `applied:false` 与原因，有效 revision 不变，不返回虚假成功。
- **APP 凭据桥**：daemon 启动时生成随机 token 写入 `<stateDir>/app-token`（0600）。`POST /api/app/secret` 仅接受 `x-graph-app-token`，浏览器会话 cookie 无效；密钥不进入配置 DTO、事件、日志或页面。Electron `graph:save-secret` 在写入钥匙串后把密钥经该通道推给运行中的 daemon；`desktop/main.mjs` 始终以 execute intent + `--dynamic` 启动，配置与密钥保存后同一进程激活，不再调用 relaunch。Setup 与 Settings 改为“保存并应用”语义，Setup 基于服务器现有文档合并（追加平台不覆盖已有配置）。
- **动态启动**：CLI 保持原有严格检查（`models_missing`、`credentials_missing`、冲突时 `invalid_config`）；只有 `--dynamic`（APP）允许 execute intent 在无可用凭据时启动，首启显示“未配置”，保存/推送后在同一 daemon 上启用。
- **发送时解析**（`src/runtime/pi-adapter.ts`、`controlled-openai.ts`、`model-scheduler.ts`）：
  - 实际发送前重新解析 key；密钥轮换只影响尚未发送的调用，已发送调用保持旧凭据结算。
  - 调度器 `SlotRequest.refresh` 在每次授权决策时重新解析身份与限额，`wake()` 在配置应用后重新评估队列；等待中的请求若身份/限额变化，会归还旧名额并以新身份重排。
  - 端点/协议/请求头变化时，等待中的调用不会把新 key 发给旧 endpoint：执行前检测到变化即抛 `model_changed`，由下一次安全准备或明确问题处理。
  - 降低并发限制立即生效：已有调用保留计数，新发送等待自然回落。
- **有效版本**：任务创建事件记录 `live.revision()`；`/api/startup`、`/api/config` 返回实际有效 revision；SSE/设置页显示当前运行版本。

## 测试适配

- m8/credentials：config API 断言从“报告重启”改为“热应用”响应。
- m8/integration：配置保存后不再要求重启即可继续。
- m8/rework（revision 语义）：保存后创建的任务立即记录新 revision（此前记录旧的有效版本）。
- m8/settings-ui：保存后显示已应用、`effective-revision` 前进且不出现重启提示。
- 启动冲突顺序保持：execute 严格模式先报 `invalid_config`，再报缺凭据。

## 验证

- `tsc --noEmit`、`tsc -p tsconfig.web.json --noEmit`、`vite build`：rc=0。
- `vitest run`：**61 → 62 文件 / 308 项通过**（新增 `tests/console/hot-config.test.ts` 7 项）。
- 新增用例覆盖：干净 APP 首启 → 保存模型 → 推送 key → 同一 daemon 派发（master 实例/session 不变）；“一请求在途 + 一请求排队”时轮换 key（在途旧 key、排队新 key）；移除 key 阻止新发送并保持消息待处理；无 token/错 token/仅会话 cookie 访问 app 桥被拒；被拒候选保留旧有效绑定与旧 key；端点与 key 同时变化时新 key 不进入旧 endpoint；调度器降低限额与按新身份重排。
- 原始输出：`acceptance-evidence/unified-console/u03/verification.output.txt`。

## 边界与后续

- OAuth/订阅登录、RPM/TPM/429 冷却不在本轮；本轮只支持 API key（环境变量或 APP 钥匙串）。
- APP 中“删除/禁用连接”的显式按钮随 U05 提供；当前禁用路径为 `pushSecret(ref, null)`（有测试）。
- 密钥不落盘到 daemon 内存之外；daemon 重启后由 APP 继续通过子进程环境与钥匙串恢复（既有行为）。
- 运行时没有第二套 CLI 或 Pi 旁路；热更新只作用于宿主绑定与调度器。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/hot-config.test.ts
./node_modules/.bin/vitest run
```
