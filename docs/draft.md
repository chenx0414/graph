"图 Graph"可以表述为 $G(V, E, S, P)$ 
- $V$ 是节点（Vertices），是系统里一个个独立可执行单元，一进一出，只做一件事情，例如 subagent、工具 (tool)、各类功能组件
- $E$ 是边（Edges），也就是节点之间的路由，控制接下来去哪，例如直通、条件分支、扇入、扇出、回环
- $S$ 是状态（State），沿着边流动，是所有节点都共读共写的对象，保存整个任务的全局信息，例如记录任务、证据、预算、产物、检查点
- $P$ 是策略（Policy），约束谁能创建节点、调用工具、修改图

几种基本的subagent：
- 代码生成 subagent
- 代码 review subagent
- 质检 subagent
- ship subagent
- 路由 subagent

几种基本的"图 Graph"，下面几种拓扑不是互斥的框架选型，而是可以拼装、嵌套的积木：
- 扇出扇入（fan-out/fan-in）
	```mermaid
	flowchart TD
    Input[Input] --> A[Branch A]
    Input --> B[Branch B]
    Input --> C[Branch C]
    Input --> D[Branch D]
    A --> Merge["Merge / synthesize"]
    B --> Merge
    C --> Merge
    D --> Merge
    Merge --> Result[Result]
	```
- 主管-工人模式（Orchestrator-Workers）：一个主管智能体居中调度 把任务分派给研究、写码、审查等专职工人
	```mermaid
flowchart TD
    %% 节点定义
    Cit["Citations<br>subagent"]
    Lead["<b>Lead agent</b><br><b>(orchestrator)</b><br><br>Tools: search tools + MCP tools<br>+ memory + run_subagent +<br>complete_task"]
    Mem["Memory"]

    S1["Search subagent"]
    S2["Search subagent"]
    S3["Search subagent"]

    %% 连线关系
    Lead --> Cit
    Lead <--> Mem

    Lead <--> S1
    Lead <--> S2
    Lead <--> S3

    %% 自环
    S1 --> S1
    S2 --> S2
    S3 --> S3
	```
- 流水线（Pipeline）：把任务拆成一串固定步骤，每一步处理上一步的输出，还可以在中间加程序化的检查点，来保证流程没跑偏，适合能够被干净拆解成固定子任务的场景
	```mermaid
	flowchart LR
    A[Draft Outline] --> B[Checkpoint Gate]
    B --> C[Write Main Content]
    C --> D[Deliver]
	```
- 路由（router）：先给输入分类 再导向专门的后续处理
	```mermaid
flowchart LR
    In((In)) --> Router[LLM Call<br>Router]
    Router --> L1[LLM Call 1]
    Router -.-> L2[LLM Call 2]
    Router -.-> L3[LLM Call 3]
    L1 --> Out((Out))
    L2 -.-> Out
    L3 -.-> Out
	```
- 评估-优化循环（Evaluator-Optimizer loop）：一个生成、一个评估打分，循环迭代直到达标，适合有明确评价标准，而且迭代能带来明显提升的场景
	```mermaid
	flowchart LR
    In((In)) --> Gen[LLM Call<br>Generator]
    Gen -- Solution --> Eval[LLM Call<br>Evaluator]
    Eval -- Accepted --> Out((Out))
    Eval -- Rejected + Feedback --> Gen
	```
- 验证器（Verifier）：有以下三种
	- 对抗式验证器 
		```mermaid
flowchart TD
    C[Conclusion]
    S1[Skeptic 1]
    S2[Skeptic 2]
    S3[Skeptic 3]
    S4[Skeptic 4]
    S5[Skeptic 5]
    Sn[Skeptic N]
    S1 --> C
    S2 --> C
    S3 --> C
    S4 --> C
    S5 -.-> C
    Sn -.-> C
    C --> V[Majority cannot refute<br/>Conclusion holds]
		```
	- 多视角验证器
		```mermaid
flowchart TD
    Core[Core Agent]
    V1[Correctness]
    V2[Security]
    V3[Reproducibility]
    V4[Other Viewpoints]
    V1 -.-> Core
    V2 -.-> Core
    V3 -.-> Core
    V4 -.-> Core
    Core --> Result[Multi-dimensional Verification]
		```
	- 评委式验证器
		```mermaid
flowchart TD
    A["Plan A"]
    B["Plan B"]
    C["Plan C"]
    D["Plan D"]

    A --> J1["Judge 1"]
    B --> J2["Judge 2"]
    C --> J3["Judge 3"]
    D --> Jn["Judge N"]

    J1 --> Select["Score & Rank"]
    J2 --> Select
    J3 --> Select
    Jn --> Select

    Select --> Winner["Winner"]
    Select --> RunnerUp["Runner-up"]

    %% 增加：胜者吸收亚军优点的双向/单向连线
    RunnerUp -.-> Winner
		```




subagent 设想：
- 不同 subagent 的区分是由 LLM 本身能力、subagent 拥有的独特 skills 与 MCP 来进行划分
- 设立一个 subagent 专门用来创造其他 subagents，通过配置 LLM、skills、MCP 来设立 subagents，并且给这个 subagent 进行命名、介绍背景
- 会同时接入多个厂商的 API key 与其中的多个 LLM 来应对不同场景需求，并且避免并行阻塞
- 代码生成 subagent 与代码 review subagent 不可使用同一个 LLM
- 对不同 LLM 设立四个智能等级（低、中、高、最高），例如 deepseek-V4-flash 为低、deepseek-V4-pro 为中、kimi-k3 为高、GPT6-astra 为最高
- Master Agent 可以自定义编排"图 Graph"
- 每个 subagent 都有自己独立的工作空间，并且所有 agents 有一个共读共写的公用空间

关键心法：最小可实现 MVP
不要为了图而图，多智能体系统确实更强，但它是靠烧更多 token 换来的，所以它只值得用在那些价值足够高、足以覆盖成本的任务上；Anthropic 给出了三个明确该用多智能体的场景：第一是上下文保护，当某个子任务会产生大量但对主任务无关的信息时，就可以用独立子智能体隔离出去，保持主上下文干净；第二是可并行任务，能切成多个独立分支同时跑，探索比单智能体更大的搜索空间，尤其适合广度优先的研究搜索；第三是专业化，不同步骤需要不同的工具、提示或专注度，拆开能提升工具选择的准确率和任务专注度。反过来 如果任务就一个目标、一个领域、一个明确的停止条件，那清晰的单个循环就是最优解

典型使用场景：
- 大型项目开发
- 论文生成

实现技术栈：
- Pi Agent：极简内核、扩展优先的 Agent
- LangGraph：采用有向图加条件边的编排模型，有内置检查点加时间旅行的状态管理，适合长时运行、需审计、需回滚的生产管线
- 编程语言：TypeScript、rust

一些典型可供选择的 skills（不限于）：
- [https://github.com/obra/superpowers-skills](https://github.com/obra/superpowers-skills)：面向编码 Agent 的软件开发方法论技能库
- [https://github.com/garrytan/gstack](https://github.com/garrytan/gstack)：完整 AI 工程团队工作流技能集，模拟 CEO、设计师、QA、安全工程师等角色，覆盖从规划到部署全流程
- [https://github.com/mattpocock/skills](https://github.com/mattpocock/skills)：面向真实工程师的轻量化可组合技能包，包含需求调研、规范评审、TDD、架构设计等实战技能
- [https://github.com/mcncarl/yichen-skills](https://github.com/mcncarl/yichen-skills)：创作者向技能集，包含微信、公众号、X 平台处理、语音转写、网页调研、Agent 记忆等中文场景工具
- [https://github.com/American-Embedded/kistack](https://github.com/American-Embedded/kistack)：端到端功能开发技能套件，支持多仓库 PRD、技术规格拆解、测试场景生成、PR 提交全链路
- [https://github.com/luongnv89/skills](https://github.com/luongnv89/skills)：通用工程技能合集，代码评审、发布管理、产品规划、前端设计、文档生成等，兼容多类 AI 编码 Agent
- [https://github.com/tscircuit/skill](https://github.com/tscircuit/skill)：电子电路硬件设计技能，用于生成 tscircuit 电路原理图、PCB 模板与检查清单
- [https://github.com/KKKKhazix/khazix-skills](https://github.com/KKKKhazix/khazix-skills)：中文实用技能，目标拆解、磁盘清理、AI 资讯查询、项目洁癖整理、竞品深度研究、公众号写作等
- [https://github.com/affaan-m/ECC](https://github.com/affaan-m/ECC)：大规模 Agent 能力增强系统，集成大量技能、记忆、安全扫描、持续学习，适配多款 AI 编码工具
- [https://github.com/Fission-AI/OpenSpec](https://github.com/Fission-AI/OpenSpec)：规范驱动开发技能，在写代码前锁定需求规格，管理提案、任务与变更记录
- [https://github.com/anthropics/skills](https://github.com/anthropics/skills)：Anthropic 官方 Agent-Skills 标准示例仓库，提供创意、技术、企业流程类标杆参考技能
- [https://github.com/K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)：科研领域专用技能库，覆盖基因组、生物医药、化学、时序预测等 160+科研工作流
- [https://github.com/VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)：精选社区技能合集，收录各大厂商与工程团队生产环境实际使用的 Agent 技能
- [https://github.com/Imbad0202/academic-research-skills](https://github.com/Imbad0202/academic-research-skills)：学术研究全流程技能，文献检索、引文格式化、论文撰写、质量校验，辅助科研产出
- [https://github.com/Fokkyp/SoftwareCopyright-Skill](https://github.com/Fokkyp/SoftwareCopyright-Skill)：软件著作权申请材料自动生成技能，读取项目源码输出软著全套申请文档
- [https://github.com/handsomestWei/patent-disclosure-skill](https://github.com/handsomestWei/patent-disclosure-skill)：专利辅助技能，实现专利创新点挖掘、查新、技术交底书撰写、Word 导出闭环工作流
- [https://github.com/kepano/obsidian-skills](https://github.com/kepano/obsidian-skills)：Obsidian 知识库专用技能

一些典型可供选择的 MCP（不限于）：
- jira：Jira 工单管理 — 搜索、创建、更新、评论、流转工单
- github：GitHub 操作 - PR、Issue、仓库管理
- firecrawl：网页抓取与全站爬虫
- supabase：Supabase 数据库操作
- sequential-thinking：链式思考推理（CoT）
- vercel：Vercel 项目与部署管理
- railway：Railway 部署管理
- cloudflare-docs：Cloudflare 文档检索
- cloudflare-workers-builds：Cloudflare Workers 构建管理
- cloudflare-workers-bindings：Cloudflare Workers 绑定配置
- cloudflare-observability：Cloudflare 可观测性、日志查询
- clickhouse：ClickHouse 分析查询
- exa-web-search：Exa API 网页搜索、调研与数据提取，适合大范围资料调研
- context7：实时文档查询，用于代码库文档检索
- magic：Magic UI 组件库查询
- filesystem：文件系统读写操作
- playwright：Playwright 浏览器自动化与测试
- fal-ai：fal.ai 模型，图像 / 视频 / 音频生成
- browserbase：Browserbase 云端浏览器会话
- browser-use：AI 浏览器 Agent，自动执行网页任务
- laraplugins：Laravel 插件检索，按关键词、版本兼容性查找 PHP 包
- confluence：Confluence Cloud 集成，搜索页面、读取内容、浏览空间

评测 evaluation：
- 记录每个 subagent 消耗的 token 、真实费用、处理时间

项目名称：待定
特点：自由度高、上手难度低、可轻可重、可视化

