# 技能写作与沉淀

**什么时候读**：要写一个新技能、改一个已有技能，或想知道技能该放哪里、怎么验收时。只是**用**技能（读它的 SKILL.md）不需要本文件。

## 技能放在哪里

技能就是一份 `SKILL.md`（可选配套 `references/`、`scripts/`、`templates/`）。按用途选位置，优先级从高到低：

| 位置 | 适用 | 是否随 Git 走 |
|---|---|---|
| `<项目根>/.agents/skills/<id>/` | **本项目专属**的工作方式、约定、坑（推荐默认去处） | 是（可 PR、可回退、可审） |
| `<项目根>/.pi/skills/<id>/` | 同上，Pi 自己的项目目录 | 是 |
| `<graph home>/capabilities/skills/<id>/` | **跨项目复用**的能力库条目；需额外一份 `capability.json`，并被 recipe 显式引用才生效 | 否（库内，靠版本与 digest） |
| `<graph home>/agents/<recipe>/skills/` | 配方绑定技能的镜像目录（自动生成，不要手写） | 否 |

判定顺序：**先写项目技能**。只有当同一课在第二个项目也要用，才晋升到能力库（见下）。

## front matter 契约

```markdown
---
name: heartbeat-check          # 必填，必须与目录名完全一致
created-by: graph-agent        # 自著技能声明（见「谁会被检查」）
description: Verify a service is still answering before blaming the code. Use when a long-running process stops responding and you need to separate a dead process from a slow one.
---
```

- `description` **必须写清「何时使用」**（`Use when …` / `何时…` / `当你…`）。模型就是靠这一句决定要不要读这份技能——没有触发条件的描述等于没有技能。
- 描述是**一句话的索引**：≤ 300 字符。正文之外的细节放 `references/`。
- 「课 = 可泛化的规则 + 一句 why」，命令式、挂在受影响的那一步、**只说一遍**。不要写 PR/issue 号、日期、引述的对话；规则要能脱离那次事件独立成立。
- 技能出问题时**就地改那句话**，不要在下面追加「UPDATE: 其实……」。
- `disable-model-invocation: true` 表示这份技能**不进模型的可见清单**，只能由使用者用 `/skill:<name>` 显式调用（对「只给人用的流程」才这样写）。

## 谁会被检查（技能 lint）

```bash
node --run skills:lint                       # 只查自著技能（推荐日常用）
node scripts/skills-lint.mjs --skills tests/fixtures/skills/good --strict   # 直接指定技能容器（fixture 用）
node scripts/skills-lint.mjs --all           # 连同别人写的技能一起过一遍硬规则
node scripts/skills-lint.mjs --json --strict # 机器可读 / 有警告就退出 1
```

**默认只查自著技能**（front matter 声明 `created-by: graph-agent`）。导入的、上游的、别人手写的技能**不在默认范围内**——那些文本不归我们改，把我们的写作偏好套上去是越界。这一点有实测依据：本仓库 22 个既有项目技能里 15 个不符合下面这套规则，而它们都不是我们写的。

| 规则 | 层级 | 判据 |
|---|---|---|
| `missing-frontmatter` | 硬 | 缺 `name` 或 `description` |
| `name-mismatch` | 硬 | `name` 与目录名不一致 |
| `description-too-long` | 硬 | 描述 > 300 字符 |
| `oversized-body` | 硬 | 正文 > 24,000 字符（`read` 会把整篇载入上下文并停留整场会话） |
| `references-sprawl` | 硬 | `references/` 超过 60 个文件 |
| `references-incident-named` | 硬 | 引用文件名以日期开头，或含 `-incident-`/`-session-`（应按主题命名） |
| `description-not-triggering` | 建议 | 描述里没有「何时使用」句式（仅自著技能） |
| `incident-log-shape` | 建议 | 正文里 issue 号与日期合计超过 3 处（仅自著技能） |

lint **只警告不阻断**：`--strict` 才会因警告退出 1（供 fixture 检查使用）。

## 怎么验收一个技能

1. **它真的被注入了**：在控制台「Agent 上下文」里确认 `<available_skills>` 里出现它——那个面板与实际注入同源（同一组装路径、同一技能目录）。项目技能免绑定，新建后新会话即可见。
2. **路由对**：自著技能带 `created-by: graph-agent`，且 `node --run skills:lint` 对它零警告。
3. **真的有用**：写下它的**触发场景**（在什么任务、什么信号下会读到它），并在下一次遇到该场景时确认它被读到——`GET /api/skill-stats` 按技能给出「被读次数 / 最近一次 / 从未被读」。

## 自动沉淀（可选开关，默认关）

开关开时，主 Agent 的**每次操作收尾后**会额外发一个**受限副调用**：拿本次操作的最后一条使用者消息、回复与既有技能清单，问它「这次学到了什么值得留下的东西」，返回一份技能文档 + 元数据；**写盘由 Graph 自己的代码做**（`src/runtime/sediment.ts`），所以边界是结构性的，不靠模型自律。

```jsonc
// <graph home>/graph.config.json
"skills": {
  "sedimentation": {
    "enabled": false,        // 默认关：开了就会产生真实模型成本
    "afterToolCalls": 10,    // 一次操作用到 ≥ 这个次数的工具调用才值得自省
    "model": "low",         // 留空就自动挑一个比主模型便宜的（不同档位/不同模型）
    "budgetTokens": 40000    // 上限口径：写进配置供审计（单次请求另受 maxTokens 硬限制）
  }
}
```

行为边界（都有测试与 E2E 守着）：

- 只对**主 Agent** 的操作触发；开关关、任务已暂停、工具调用数不足 → **一个请求都不发**。
- 只写 `<项目根>/.agents/skills/<id>/SKILL.md`，必定带 `created-by: graph-agent`；**id 逃逸、描述没有「何时使用」、空正文、要覆盖别人写的技能 → 一律拒绝且不落盘**。
- `Nothing to save.` 是合法结果，且确实什么都不写。
- 失败/超时绝不影响正在跑的那个回合（评审是操作的回声，不是它的步骤）。
- 计入用量归因的用途为 `skill_sediment`（可与普通回合、压缩、输入建议分开看）。

可复现验证：`node --run e2e:sediment`（注入模型回复，真实跑门控/解析/落盘 + 真实 `skills:lint --strict`，不联网、不开端口）。

## 沉淀与晋升的边界

- **只写项目技能目录**（`<项目根>/.agents/skills/`）。**能力库与上游技能一律只读**：要改库内技能，先提出一个等待使用者确认的问题（`kind: 'waiting'` + `requestType: 'user_decision'`），不要自行改。
- **晋升**（项目技能 → 能力库）：
  ```bash
  curl -s -b /tmp/graph-cookie.txt -H 'content-type: application/json' -H 'origin: http://127.0.0.1:<port>' \
    -X POST http://127.0.0.1:<port>/api/skills/promote -d '{"skillId":"<项目技能 id>"}'
  ```
  晋升会写 `capability.json`（含 `createdBy: "graph-agent"`、内容 digest 作为 `version`）。**它不会自动绑定到任何 recipe**——绑定是使用者的决定（见 `docs/agent/agent-recipes.md`）。
- **不要沉淀**（这些会变成日后引用来自我拒绝的约束）：环境相关失败（缺二进制/未装包/凭据未配）、对工具或功能的负面断言、会话内自行恢复的临时错误、一次性任务叙述、**未解决的失败**（没找到可行方法时就不写，别把死路包装成「推荐做法」）。
