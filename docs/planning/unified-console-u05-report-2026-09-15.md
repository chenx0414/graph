# U05 平台选择与一键配置：实施与验证报告

日期：2026-09-15。分支 `feat/unified-console`。前置 `30e8b83`（U04）。

## 交付内容

- **模板驱动的向导**（`src/web/Setup.tsx`）：首屏只有平台选择（OpenAI / Anthropic / Google Gemini / DeepSeek / OpenRouter / 自定义）、API key、推荐模型勾选；默认端点、传输、凭据引用、模型明细放入可展开的“高级设置”，不填也能得到合法配置。
- **一次动作保存并应用**：密钥先经钥匙串 + APP 桥推给运行中的 daemon（不进入配置文件/日志/页面状态，输入框保存后清空），随后把连接文档合并进现有配置并热应用；响应区分“已保存并应用 / 已保存但未生效”，不再提示重启。
- **追加而不覆盖**：`buildTemplateConfigDocument` 按模型 id 与凭据 id 合并；已有平台保留，测试验证一次会话追加 openai 与 anthropic 两个平台、各自两个模型且凭据互不影响。
- **角色说明与审查缺口**：展示主 Agent/审查使用最高等级、实现使用 medium/high；只有一个模型时明确提示需要独立审查的派发会报缺模型，不偷偷放宽规则。
- **错误反馈**：字段级校验（模型、端点、凭据引用/id、项目 id）；密钥存储失败单独提示；连接测试是显式按钮，使用所选协议，展示 HTTP/延迟并提示会计费；保存本身不发模型请求（测试断言）。
- **连接测试按协议**：U04 的 `/api/config/test` 对 Anthropic 使用 `x-api-key` + `/messages`。

## 验证

- `tsc` 主/Web、`vite build`、全量 `vitest run`：**64 → 65 文件 / 315 项通过**。
- 新增 `tests/console/setup-wizard.test.ts`（真实 Chromium + 受控本地供应商）：
  - 干净启动（无连接）→ 选平台、填高级端点、保存 → `applied:true, configured:true, effectiveRevision:1`，同一 daemon 可创建会话，页面显示“已保存并应用”；
  - 保存与密钥不触发任何模型请求（0 请求），显式“测试连接”才发出一次最小调用并显示成功；
  - 追加第二个平台后配置中两个 provider、四个模型共存，第一家凭据未被覆盖；
  - 非法凭据引用保留表单、标记字段且配置文件 revision 不变。
- 原始输出：`acceptance-evidence/unified-console/u05/verification.output.txt`。

## 边界与后续

- 浏览器模式仍需环境变量提供密钥（提示已给出）；钥匙串路径的真实 Electron 实测在 U11。
- 连接/禁用/轮换的按钮级入口：轮换=重填 key 再保存；禁用=设置页删除凭据条目（U10 会补显式“禁用连接”入口并单独验证）。
- 未运行真实付费供应商冒烟。

## 复现

```sh
cd /Users/macmini/workspace/graph-unified-dev
export PATH="$PWD/node_modules/.bin:$PATH"
./node_modules/.bin/vitest run tests/console/setup-wizard.test.ts
```
