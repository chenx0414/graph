# 缓存预热（cache pre-warming）：通行做法，以及 Graph 该不该做

调研日期：2026-11-10。问题是「缓存预热该怎么做」。本文先讲清机制（前缀不变才命中），再逐家列出官方做法，最后用本机数据判定 Graph 做预热值不值，并给出可验证的下一步。

**结论速览**：预热不是省钱手段，是**花钱买延迟**——它把一次 miss 提前成用户无感的时刻，总计算量只增不减。Graph 当前链路的前缀命中率已 99.7%（采样 157 次里 155 次命中），冷启代价约 +3~6s，所以通用预热的期望收益在几十毫秒量级，不值得建。值得做的只有两件低成本事：一条「前缀稳定性」用例防止有人往系统提示里塞时间戳，以及把压缩事件与下一次调用的 `cacheRead` 关联起来先测出冷启率，再决定要不要做「压缩后预热」。

## 一、机制：三种「缓存」不是一回事

- **隐式前缀缓存**（OpenAI、Fireworks、DeepSeek）：服务端按最长公共前缀自动复用 KV，不用改代码。命中前提是**从第 0 个 token 起完全相同**，并且落在同一台机器/同一副本上。
- **显式断点 + TTL**（Anthropic）：由 `cache_control` 标出可缓存块，TTL 默认 5 分钟、可长到 1 小时，写入按更高单价计费。
- **硬盘前缀单元**（DeepSeek）：命中要求**完整匹配一个已落盘的「缓存前缀单元」**，见 §三。

三种机制下「预热」都只有同一个物理含义：**在用户真正提问之前，先发一次能覆盖目标前缀的请求，让服务端把它写进缓存**。

## 二、Anthropic：显式断点 + 主动预热 + 投机预热

一手来源：官方文章 [Reducing cost and improving performance with Claude Platform](https://claude.com/resources/articles/reducing-cost-and-improving-performance-with-claude-platform)（本机可读）；[Prompt caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 的 `#pre-warming-the-cache` 小节与 [Speculative prompt caching cookbook](https://platform.claude.com/cookbook/misc-speculative-prompt-caching) 在本机因地区封锁只能读到检索摘要。

官方原文给出的预热手法：

> Pre-warm the cache. To reduce latency, send a request with `max_tokens: 0` and an explicit cache breakpoint. This processes the prompt and writes it to the cache without generating anything. If you run it at session start (for example, while a user is typing), the first real request hits a warm cache.

同一篇里三条与预热直接相关的约束：

1. **TTL 从请求开始计**，不是从请求结束计。如果 agent 在工具调用或子 agent 上阻塞超过 5 分钟，父请求的缓存已经过期，「结果回来时缓存没了」。这种情况应该给前缀设 1 小时 TTL。
2. **断点要随对话增长前移**，否则断点之后的内容每次都是 miss。
3. **换模型/换思考档位要挑「反正要吃 miss 的时刻」**——压缩（compaction）本身就重写了大部分上下文，那就是免费切换的窗口。

Cookbook 的做法是把预热提前到「用户还在打字」时：先把大段上下文（文档、系统提示）发一次写进缓存，等真实提问到达时前缀已经热了——即标题里的 speculative prompt caching。

## 三、DeepSeek：缓存前缀单元，必须完整匹配

一手来源：[上下文硬盘缓存（官方中文文档）](https://api-docs.deepseek.com/zh-cn/guides/kv_cache.md)，本机直连可读。这是对我们的网关模型（`deepseek-v4.1-flash`）最相关的一份。

- 硬盘缓存默认开启，无需改代码；但命中是**尽力而为**，不保证。
- 每条缓存前缀是**独立完整单元**，后续请求必须**完整匹配某个单元**才能命中——不是「最长公共前缀命中」那么宽松。
- 落盘有三个时机：① 每次请求的**用户输入结束位置**与**模型输出结束位置**各产生一个单元；② 系统检测到多次请求存在公共前缀时，把该公共前缀单独落盘；③ 长输入/长输出中按固定 token 间隔截取单元，避免长前缀因为迟迟不到结束位置而完全不被缓存。
- 官方举的反例正是「长文档 + 不同问题」：前两次请求都不会命中，第二次之后系统才把 `system + <文档>` 这个公共前缀落盘，第三次才吃到命中。
- 观测字段 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存不再使用后自动清空，「时间一般为几个小时到几天」。

对 Graph 的含义：TTL 是小时到天级，所以「保活心跳」几乎不需要；真正会 miss 的是**前缀被重写**的时刻（压缩、换配方、换模型）。

## 四、OpenAI：自动前缀 + 路由粘性键

官方页（`developers.openai.com/api/docs/guides/prompt-caching`、`openai.com/index/api-prompt-caching/`）在本机返回 403，以下依据检索摘要，标注为待复核：

- 前缀 ≥1024 token 才启用；缓存按组织隔离。
- 旧行为：**5–10 分钟不活跃后清除，最迟在上次使用后 1 小时内移除**。
- 「只共享前缀还不够，还要落在同一台机器」：官方 cookbook 建议传 `prompt_cache_key`，它会与前缀哈希结合，**提高同一前缀落到同一 engine 的概率**（路由粘性），这是「预热了却命中不了」的常见原因。
- 新接口提供 `prompt_cache_options.ttl` 选择最低存活时长（默认 `30m`），写入按 1.25× 未缓存单价计费——即**预热是要花钱的**。

## 五、Fireworks：默认前缀缓存 + 会话亲和头

一手来源：[Prompt caching](https://docs.fireworks.ai/guides/prompt-caching)，本机可读。

- 默认开启；官方称「在很多场景下可把 TTFT 降低最多 80%」；缓存 token 在 serverless 上默认 5 折计费。
- **缓存只在一个副本内有效**，多副本部署必须给路由提示：`user` 字段或 `x-session-affinity` 头，让共享前缀的请求落到同一副本；否则命中率会被随机路由摊薄。
- 缓存通常保留「至少几分钟」，视模型与负载可达「几个小时」，按最老优先淘汰。
- 需要缓存隔离时用 `x-prompt-cache-isolation-key` / `prompt_cache_isolation_key`。
- 明确的结构规则：**静态内容（指令、示例、工具定义）放最前，用户相关内容放最后**；时间戳这类动态内容放进系统提示开头会「一秒之差就让整条缓存失效」。

## 六、归纳：六种「预热」模式

| 模式 | 做什么 | 前提 | 代价与失败方式 |
| --- | --- | --- | --- |
| P1 前缀稳定化 | 不在前缀里放时间戳/随机 id；静态在前、动态在后 | 无 | 几乎零成本；不是发送预热但效果等同，是其它模式的前提 |
| P2 投机预热 | 用户输入期间先发一次覆盖前缀的请求（Anthropic `max_tokens: 0` + 断点） | 用户有可观输入停顿；前缀可提前确定 | 白付一次写入费；用户改主意/换会话就浪费 |
| P3 重写后预热 | 压缩、换模型、换配方后立刻预热新前缀 | 知道何时发生了前缀重写 | 只在「下一次请求一定会来」时划算 |
| P4 保活心跳 | TTL 到期前重发一次 | TTL 短（分钟级）且会话会闲置 | DeepSeek 级别 TTL 下无意义；心跳要重传全文 |
| P5 路由粘性键 | `prompt_cache_key` / `x-session-affinity` / `user` | 服务端多副本 | 键不稳定反而打散缓存 |
| P6 显式断点 + 长 TTL | `cache_control` + 1h TTL | 供应商支持显式断点 | 写入单价更高；断点不随上下文前移就退化成「每次都 miss」 |

共同约束：**预热永远不能让总成本下降**。它把一次 miss（单价 100%）变成一次写入（≥100%）加一次命中（几十分之一），只能省延迟。

## 七、Graph 现状（代码证据）

- 请求体构在 `backend/internal/graph/runtime_model_runtime.go` 的 `providerRequestBody`：只写 `model`/`messages`/`stream`/`max_tokens`/`system`。全仓库检索 `prompt_cache`、`cache_control`、`x-session-affinity` 均无命中——**目前没有断点、没有路由粘性键、没有任何预热**。命中完全依赖网关自己的隐式前缀缓存。
- 系统提示里的动态段只有 `NODE WORKING ENVIRONMENT`（`runtime_kernel_graph_lane_session.go`），内容仅 `workspace` + `base`（`kernelGraphLaneWorkingEnvironment`），不含时间戳；同一会话内稳定。
- 历史是追加式的：每一步把上次的 assistant / 工具结果续到尾部。
- 会重写前缀的动作：`pigkernel/compaction.go` 的压缩（DB 里 `session.compacted` 48 次、`session.compaction_started` 26 次）、切换模型/配方（node rebind）。

## 八、本机实测（可复跑）

数据库：`~/Library/Application Support/Graph/state/tasks.sqlite`，`invocations.usage` 里 `cacheRead` 是命中 tokens、`input` 是**未命中** tokens，命中率取 `cacheRead / (cacheRead + input)`。

```sql
-- 命中率分布（最近 400 次有 TTFT 的调用）
with r as (select json_extract(usage,'$.cacheRead') cr, json_extract(usage,'$.input') inp,
                  json_extract(usage,'$.contextTokens') ctx, json_extract(usage,'$.firstTokenMs') ttft
           from invocations
           where json_extract(usage,'$.firstTokenMs') is not null
             and (json_extract(usage,'$.cacheRead') + json_extract(usage,'$.input')) > 0
           order by dispatched_at desc limit 400)
select case when cr=0 then 'cold' when cr*1.0/(cr+inp)<0.5 then '<50%'
            when cr*1.0/(cr+inp)<0.9 then '50-90%' else '>=90%' end bucket,
       count(*) n, round(avg(ttft)/1000.0,2) ttft_s, round(avg(ctx)/1000.0,0) ctx_k
from r group by bucket order by bucket;
```

结果（2026-11-10 采样）：

| 桶 | 次数 | 平均 TTFT | 平均上下文 |
| --- | --- | --- | --- |
| 冷启（0%） | 2 | 11.46s | 409k |
| <50% | 1 | 6.49s | 280k |
| ≥90% | 155 | 9.81s | 529k |

按上下文分桶看「热调用」的 TTFT：

| 上下文 | 次数 | 平均 | 最小 | 最大 |
| --- | --- | --- | --- | --- |
| 200–400k | 32 | 3.52s | 3.1s | 6.5s |
| 400–500k | 24 | 26.25s | 5.4s | 145.6s |
| 500–600k | 61 | 7.30s | 5.3s | 13.9s |
| 600k+ | 47 | 8.36s | 7.2s | 10.7s |

两条真实冷启（`cacheRead=0`）：344,579 tokens → 9.73s；473,642 tokens → 13.19s。与同尺寸热调用比（200–400k 均值 3.5s、500–600k 均值 7.3s），**冷启代价约 +3~6s**。

TTFT 分解（最近 157 次）：`uploadMs` 均值 1.45s（最大 3.26s），`serverWaitMs` 均值 5.58s。也就是说即使 100% 命中，仍有约 7s 花在「把整段上下文传上去」和「等网关吐第一个字」，这部分**预热完全换不来**。

成本侧（`src/catalog/price-snapshot.ts`，DeepSeek 峰时）：命中 0.006 vs 未命中 0.3 USD/百万 tokens，**50×**。50 万 token 的前缀：一次 miss ≈ $0.15，一次命中 ≈ $0.003。

## 九、判定

预热期望收益 ≈ `P(否则会冷启) × ΔTTFT` − `P(否则会命中) × 写入成本` − `上传成本`。

代入本机数据：`ΔTTFT ≈ 3~6s`，`P(冷启) ≈ 2/157 ≈ 1.3%` → 每次调用期望省下约 **40~80ms**；而一旦「本来会命中」却又预热了一次，反而多付一次写入。所以**通用预热净收益为负**。

这和 Anthropic 文档的适用条件是一致的：预热针对的是「会话开始的第一次交互」和「TTL 5 分钟且用户会停顿」这类场景。我们的 TTL 是小时到天级（DeepSeek），并且 agent 循环是连续发请求、前缀只追加，所以天然一直在命中。

## 十、建议（按 ROI 排序）

1. **做：加一条前缀稳定性用例。** 同一会话连续两步构建出的请求体，除尾部新增消息外前缀必须逐字节相同（系统提示、工具定义、历史序列化都不能漂）。这是唯一能防住「有人往系统提示里加时间戳/随机 id 把 99.7% 打成 0%」的护栏，且是纯断言、不依赖网络。
2. **做：把压缩事件和下一次调用的命中情况关联成一条统计。** 现在 `firstTokenMs` 只覆盖最近 157 次，48 次压缩事件几乎全在埋点之前，因此「压缩后到底会不会全 miss」还没测过——**先测冷启率，再谈预热**。做法：`events` 里 `session.compacted` 之后 120 秒内的第一条 invocation 取 `cacheRead/(cacheRead+input)`，按天聚合。
3. **可选（测出来冷启率足够高再做）：压缩后预热。** 压缩完成、下一条用户消息到来之前，拿新前缀发一次 `max_tokens: 1` 的请求（Anthropic 用 `max_tokens: 0` + 显式断点；OpenAI 兼容接口下用 `max_tokens: 1` 更稳），丢弃输出。验收断言应该是「压缩后首轮 TTFT 的中位数下降」，不是「发出去了」。
4. **不做：投机预热。** 我们的前缀动辄 30 万~60 万 token，上传一次约 1.5s，还要和用户当前这次请求抢同一条上行链路；而且命中率已经 99.7%，投机预热几乎是纯支出。
5. **不做：保活心跳。** DeepSeek 硬盘缓存的存活期是「几小时到几天」，心跳只会不断重传全文。
6. **不做：路由粘性键。** 网关（command-goat）是单账号转发，没有多副本路由可控；等换到直连多副本供应商再引入 `prompt_cache_key` / `x-session-affinity`。

## 十一、未验证与风险

- 冷启样本只有 2 条，`P(冷启)` 的量级可信，具体数值不可信。
- `firstTokenMs` 是 Graph 自定义指标（含上传与排队），不等于供应商口径的 TTFT；拿它和 Anthropic/OpenAI 文档里的「TTFT 降 80%」不可直接比较。
- 网关背后是否就是 DeepSeek 官方硬盘缓存（而不是另一个中间层自己做的前缀缓存）未证实；`cacheRead` 字段语义是按实测反推的（`input` 只计未命中）。
- OpenAI 一节全部来自检索摘要，官方页在本机 403；Anthropic 文档的 `#pre-warming-the-cache` 小节同样只有摘要（地区封锁），但 `max_tokens: 0` 的原文引自可读的官方文章。
- `400–500k` 桶里最大 145.6s 的离群值原因未查（同一尺寸下既有 5.4s 也有 145s），不影响本文结论但值得单独看一眼。

## 来源

- [DeepSeek 上下文硬盘缓存](https://api-docs.deepseek.com/zh-cn/guides/kv_cache.md)（直连可读，2026-11-10）
- [Fireworks Prompt caching](https://docs.fireworks.ai/guides/prompt-caching)（直连可读，2026-11-10）
- [Anthropic: Reducing cost and improving performance with Claude Platform](https://claude.com/resources/articles/reducing-cost-and-improving-performance-with-claude-platform)（直连可读）
- [Anthropic Prompt caching 文档 · Pre-warming the cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pre-warming-the-cache)（检索摘要）
- [Anthropic Cookbook · Speculative prompt caching](https://platform.claude.com/cookbook/misc-speculative-prompt-caching)（检索摘要 + [notebook](https://github.com/anthropics/claude-cookbooks/blob/main/misc/speculative_prompt_caching.ipynb)）
- [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[Prompt Caching 201](https://developers.openai.com/cookbook/examples/prompt_caching_201)、[Prompt Caching in the API](https://openai.com/index/api-prompt-caching/)（均 403，检索摘要）
