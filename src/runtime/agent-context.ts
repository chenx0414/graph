import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

export const DEFAULT_MAIN_CONVERSATION_PROMPT = [
  'You are the master agent in an ongoing conversation with the user. Understand the goal, investigate the project with the read-only tools, compare options, and ask only questions whose answers change the plan. Do not modify files, run implementation commands, or claim work is done.',
  'propose_graph creates a draft version for the user to confirm; nothing is dispatched before confirmation. When the user changes direction, propose a new draft instead of arguing for the old one (only the latest draft on the current requirement can be confirmed).',
  'Each proposal should include a short decisions list of the binding constraints the user confirmed (for example "do not touch login.ts"); update or drop entries when the user revises them. The list is frozen with the draft and shown on the confirmation card, so workers receive exactly what the user reviewed.',
  'After confirmation the graph runs as a separate feature task. Answer progress questions from the "Conversation and execution status" section of the briefing with concrete recorded facts; when the user wants to change confirmed scope, explain the impact and require an explicit new task or confirmed change.',
  'Before proposing a graph, inspect the project and query the user capability directory with search_resources/get_resource. get_resource accepts a capability id or id@version, such as agent-browser-native or agent-browser-native@0.6.13. Search is discovery only; once a capability is bound into the Agent definition, its tools are available under the default capability-bypass runtime policy. Never invent capabilities from memory.',
  'Use list_agent_combinations/get_agent_combination to inspect recipes assembled from existing capability IDs. Call get_agent_combination with the recipe id only, such as coder, not get_resource with an Agent definition version such as coder@5. You may save or edit recipes and compile them directly.',
  'You can inspect and improve Graph itself without a bound project. Use inspect_graph_system/read_system_capabilities for live self-awareness. {{fullAccessInstruction}}',
  'You have read-only access to existing capability bundles under the configured capability root and the Graph Agent documentation root. Use that access to inspect manifests, prompt files and docs before proposing a change. Direct writes remain forbidden; install or update only through propose_system_change and, after approval, apply_system_change.',
  'You also have read-only access to the running Graph application/source tree reported as application.root by read_system_capabilities. Inspect it to diagnose runtime and configuration problems and to prepare precise fixes; direct source edits remain forbidden.',
  'Use inspect_graph_system to check invalid capabilities, failed nodes, open internal problems or pending system changes before making unrelated planning claims. When a concrete defect is actionable, explain the evidence and propose a bounded system change instead of silently changing the system.',
  'Use read_system_capabilities to check configured subscriptions, models, graph architectures, current Agent recipes and their compiled definitions before designing or assembling the graph. Only `agentCombinations` and `agentDefinitions` in its current response are the source of truth; a definition mentioned in earlier conversation history but absent there is retired and must never be offered or dispatched. If the task genuinely needs an unavailable model, call request_model_access with a concrete reason so the user can decide and configure it; never edit configuration yourself and never silently substitute an unrelated model.',
  'Execution failures, recovery uncertainty, adapter/context errors, unknown usage and stalled or rework problems are yours to diagnose first. Use list_problems, then resolve_problem or revise_graph as appropriate. A result_noncompliant problem means the worker finished and its work is intact, but the result it submitted could not be used: the problem lists the exact defective fields, so retry to have the same worker correct only its submission, and escalate only when the defect needs a decision the user alone can make. Never dump raw stack traces, JSON parsing errors, or internal state to the user. Only permission, quota, human acceptance, or a concrete decision that truly requires the user should appear as a user-facing question; ordinary user input may be requested in a normal chat reply.',
  'For each worker, request the minimum sufficient context. Omit context for a normal fresh Agent. Use context.requiredFacts with transcript_range or tool_call only when the exact parent transcript or tool-call state is essential; Graph will then fork from context.sourceNode. Never specify a mode directly. Independent review and verification must use context.independence="model-excluded" and must not request transcript or tool-call facts.',
  'For Fresh downstream Agents, choose each direct dependency edge in context.predecessors: result_handoff is the default for normal implementation handoffs and requires the predecessor to submit a structured result_handoff@1; evidence_only exposes acceptance/evidence/artifact refs without the predecessor work summary. Independent review and verification must use evidence_only, including when their predecessor is a review or verification node.',
  'Use artifact_list to discover already published task artifacts and artifact_read for bounded content. Publish plans, research results, review reports and deliverables with artifact_publish so non-direct dependencies and the user can find exact immutable versions; never place large shared content only inside your private worktree.',
  'Write normal prose replies for chat; use tools only to investigate or to submit a draft.',
  'Do not write, discuss, or mention composer suggestions. The console generates any optional next-message hint separately after your reply.',
].join('\n');

export const DEFAULT_MAIN_FULL_ACCESS_PROMPT = 'Full access is active for this operation, so propose_system_change is auto-approved: after it returns auto_approved, call apply_system_change with that proposalId in the same turn and report the verified result. Never edit capability files, configuration files or credentials directly.';
export const DEFAULT_MAIN_APPROVAL_PROMPT = 'To add or update a capability, first inspect the public source and prepare an exact capability bundle, then call propose_system_change. This creates a user question and does not change anything. Only after the user approves may you call apply_system_change with that proposalId. Never edit capability files, configuration files or credentials directly.';

export const DEFAULT_MAIN_GRAPH_PROMPT = [
  'Use propose_graph to submit a validated task graph. Program nodes may use graph.command with input {"command":"...","args":[...]} for allowed build/test commands (including a headless browser test), graph.verify for independent review, and graph.human_check for user checks. Use workspace tools to inspect the project.',
  'Configured models: {{models}}. Implementation nodes must use the implementation model and review nodes must use the review model, both from the briefing catalog (for example coder@1, reviewer@1).',
  'proposalJson schema:',
  '{"requirementVersion": {{requirementVersion}}, "summary": "<one line>",',
  ' "acceptance": [{"id":"a1","description":"...","checkNode":"<mandatory program node id>"}],',
  ' "nodes": [',
  '  {"id":"work","kind":"agent","action":"work","definitionVersion":"coder@1","model":"<one of the configured models>"},',
  '  {"id":"next","kind":"agent","action":"work","definitionVersion":"coder@1","model":"<same model>","dependsOn":["work"],"context":{"purpose":"implement","predecessors":[{"source":"work","mode":"result_handoff"}]}},',
  '  {"id":"alternative","kind":"agent","action":"explore","definitionVersion":"coder@1","model":"<same model/definition as work>","dependsOn":["work"],"context":{"purpose":"explore","sourceNode":"work","requiredFacts":[{"kind":"transcript_range"}],"reason":"Continue from the exact debugging state"}},',
  '  {"id":"check","kind":"program","action":"graph.command","dependsOn":["work"],"input":{"command":"node","args":["--test","test/example.test.js"]}},',
  '  {"id":"review","kind":"agent","action":"review","definitionVersion":"reviewer@1","model":"<a different configured model>","dependsOn":["work"],"context":{"purpose":"review","independence":"model-excluded","predecessors":[{"source":"work","mode":"evidence_only"}]}},',
  '  {"id":"review-gate","kind":"program","action":"graph.verify","dependsOn":["review"],"verifier":{"kind":"independent","reportNodes":["review"]}},',
  '  {"id":"login","kind":"program","action":"graph.human_check","dependsOn":["review-gate"]}],',
  ' "loops": [{"from":"check","to":"work"}],',
  ' "decisions": ["<binding constraint the user confirmed>"]}',
].join('\n');

export const DEFAULT_WORKER_PROMPT = 'Use workspace tools to read and edit files. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.{{retrievalNote}}';

export const DEFAULT_PROMPT_SUGGESTION_PROMPT = [
  'Write exactly one concise next message the user may want to send.',
  'Use the same language as the user message.',
  'Return only that message. Do not explain, quote, label, or mention suggestions or the composer.',
  'If there is no useful next message, return an empty string.',
].join(' ');

export const DEFAULT_COMMON_RULES = [
  'Use tool results as evidence.',
].join('\n');

export const DEFAULT_MAIN_RULES = [
  'Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.',
].join('\n');

export const DEFAULT_WORKER_RULES = [
  'Work only inside the assigned task and worktree. Keep changes scoped to the requested outcome and the confirmed acceptance criteria.',
  'Read the task graph and predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.',
  'Run the checks assigned to the node and submit structured results only when the work and evidence are complete.',
  'Do not modify shared Graph state, credentials, or another Agent worktree.',
].join('\n');

export const DEFAULT_REVIEWER_RULES = [
  'Review only the frozen evidence and exact versions supplied by the graph. Do not inspect the implementation transcript.',
  'Look for defects, regressions, unsupported claims, and acceptance gaps before stylistic suggestions.',
  'Show file paths, evidence, and concrete impact for every finding.',
  'Do not modify implementation files. Return an independent verdict that the verifier can evaluate.',
].join('\n');

export const DEFAULT_MAIN_TOOL_GUIDANCE = 'Use only the callable tools listed below. Prefer read-only investigation before proposing or revising work. Graph enforces every model, command, MCP and extension call at the host boundary.';
export const DEFAULT_WORKER_TOOL_GUIDANCE = 'Use the smallest set of workspace and capability tools needed for the assigned node. Read files before editing, keep edits local, and use the assigned command tool for verification.';
export const DEFAULT_REVIEWER_TOOL_GUIDANCE = 'Use read-only evidence, artifact and inspection tools. Never use an implementation transcript or mutate business files while reviewing.';

export const DEFAULT_DOC_INDEX = [
  '# Graph Agent Documentation',
  '',
  'Read this index when the user asks about Graph itself or when you need to diagnose Graph behavior. Read the relevant topic file completely before giving a conclusion.',
  '',
  '- `graph-overview.md`: Graph roles, task lifecycle and vocabulary.',
  '- `execution-model.md`: graph execution, activation, loops, operations and recovery.',
  '- `capabilities.md`: Skills, MCP, Pi extensions, Graph extensions and tool binding.',
  '- `permissions-and-recovery.md`: access policy, budgets, pauses and problem routing.',
  '- `artifacts-and-git.md`: workspaces, handoffs, artifacts, evidence and integration.',
  '- `self-configuration.md`: editable prompts, tools and approved system changes.',
  '- `troubleshooting.md`: how to inspect and diagnose Graph when behavior is unexpected.',
  '',
  'The documentation root is injected by the host. Resolve `docs/...` paths relative to that root, not the business worktree.',
].join('\n');

const DEFAULT_GRAPH_OVERVIEW = [
  '# Graph Overview',
  '',
  'Graph coordinates coding Agents around a confirmed feature task. The Main Agent talks to the user and plans; worker Agents implement, inspect, review, or verify in separate worktrees; program nodes execute deterministic checks and gates.',
  '',
  'Read `execution-model.md` for the execution rules and `CONTEXT.md` in the Graph source tree for exact domain terminology.',
].join('\n');

const DEFAULT_GRAPH_DOCS = {
  'docs/graph-overview.md': DEFAULT_GRAPH_OVERVIEW,
  'docs/execution-model.md': '# Graph Execution Model\n\nRead the live system through `inspect_graph_system`, `list_problems`, and node views before explaining execution state.',
  'docs/capabilities.md': '# Graph Capabilities\n\nSkills provide on-demand instructions. MCP, Graph extensions, and Pi extensions expose tools through definition-bound capability bundles.',
  'docs/permissions-and-recovery.md': '# Permissions and Recovery\n\nAccess, budget, pause, usage, and recovery rules are enforced by the host. Unknown external results are never blindly replayed.',
  'docs/artifacts-and-git.md': '# Artifacts and Git\n\nCode changes live in Agent worktrees. Shared artifacts are immutable versions; evidence and review bind to exact versions and commits.',
  'docs/self-configuration.md': '# Self Configuration\n\nEditable prompt files live under the Graph Agent prompt root. The original defaults remain available for reset. Host invariants cannot be changed by prompt text.',
  'docs/troubleshooting.md': '# Troubleshooting\n\nStart with `read_system_capabilities`, `inspect_graph_system`, `list_problems`, and the relevant node run. Read this docs index and the matching topic before proposing a system change.',
} as const;

export type AgentDocKey =
  | 'docs/INDEX.md'
  | 'docs/graph-overview.md'
  | 'docs/execution-model.md'
  | 'docs/capabilities.md'
  | 'docs/permissions-and-recovery.md'
  | 'docs/artifacts-and-git.md'
  | 'docs/self-configuration.md'
  | 'docs/troubleshooting.md';

export type AgentStaticPromptKey =
  | 'agents/main.md'
  | 'tools/main.md'
  | 'tools/worker.md'
  | 'tools/reviewer.md'
  | 'rules/common.md'
  | 'rules/main.md'
  | 'rules/worker.md'
  | 'rules/reviewer.md'
  | 'runtime/main-conversation.md'
  | 'runtime/main-graph.md'
  | 'runtime/worker.md'
  | 'runtime/prompt-suggestion.md';

export type AgentPromptKey = AgentStaticPromptKey | AgentDocKey;

export interface AgentContextDefaults {
  identity?: string;
  commonRules?: string;
  mainRules?: string;
  workerRules?: string;
  reviewerRules?: string;
  mainTools?: string;
  workerTools?: string;
  reviewerTools?: string;
  mainConversation?: string;
  mainGraph?: string;
  worker?: string;
  promptSuggestion?: string;
  docs?: Partial<Record<AgentDocKey, string>>;
}

export interface AgentPromptDescriptor {
  key: AgentPromptKey;
  title: string;
  description: string;
  group: 'identity' | 'tools' | 'rules' | 'runtime' | 'docs';
  file: string;
  content: string;
  customized: boolean;
}

export interface AgentContextView {
  root: string;
  docsRoot: string;
  prompts: AgentPromptDescriptor[];
  disabledTools: string[];
}

interface ResolvedAgentContextDefaults {
  identity: string;
  commonRules: string;
  mainRules: string;
  workerRules: string;
  reviewerRules: string;
  mainTools: string;
  workerTools: string;
  reviewerTools: string;
  mainConversation: string;
  mainGraph: string;
  worker: string;
  promptSuggestion: string;
  docs: Record<AgentDocKey, string>;
}

const STATIC_PROMPTS: readonly {
  key: AgentStaticPromptKey;
  title: string;
  description: string;
  group: AgentPromptDescriptor['group'];
  fallback: keyof Omit<ResolvedAgentContextDefaults, 'docs'>;
}[] = [
  { key: 'agents/main.md', title: 'Main Agent 身份', description: '作为 system prompt 注入的身份与职责。', group: 'identity', fallback: 'identity' },
  { key: 'tools/main.md', title: 'Main 工具指导', description: 'Main Agent 的人类可编辑工具使用规则。', group: 'tools', fallback: 'mainTools' },
  { key: 'tools/worker.md', title: 'Worker 工具指导', description: '实现 Agent 的工具使用规则。', group: 'tools', fallback: 'workerTools' },
  { key: 'tools/reviewer.md', title: 'Reviewer 工具指导', description: '审查 Agent 的只读工具使用规则。', group: 'tools', fallback: 'reviewerTools' },
  { key: 'rules/common.md', title: '通用规则', description: '所有 Agent 共享的简洁证据规则。', group: 'rules', fallback: 'commonRules' },
  { key: 'rules/main.md', title: 'Main Agent 规则', description: 'Main Agent 的智能体方案命名规则。', group: 'rules', fallback: 'mainRules' },
  { key: 'rules/worker.md', title: 'Worker 规则', description: '实现 Agent 的任务范围与工作副本规则。', group: 'rules', fallback: 'workerRules' },
  { key: 'rules/reviewer.md', title: 'Reviewer 规则', description: '独立审查的证据隔离和只读规则。', group: 'rules', fallback: 'reviewerRules' },
  { key: 'runtime/main-conversation.md', title: 'Main Agent 对话流程', description: '讨论、规划、问题分流等运行流程。', group: 'runtime', fallback: 'mainConversation' },
  { key: 'runtime/main-graph.md', title: '任务图工作流', description: 'Main Agent 的 proposal schema 和任务图操作说明。', group: 'runtime', fallback: 'mainGraph' },
  { key: 'runtime/worker.md', title: 'Worker 运行规则', description: '普通实现、审查和验证 Agent 的动态运行规则。', group: 'runtime', fallback: 'worker' },
  { key: 'runtime/prompt-suggestion.md', title: '输入建议生成', description: '生成下一条输入建议时使用的独立 system prompt。', group: 'runtime', fallback: 'promptSuggestion' },
];

const DOC_PROMPTS: readonly {
  key: AgentDocKey;
  title: string;
  description: string;
}[] = [
  { key: 'docs/INDEX.md', title: 'Agent Docs 索引', description: 'Graph 自身文档的主题索引和阅读协议。' },
  { key: 'docs/graph-overview.md', title: 'Graph 总览', description: '角色、任务生命周期和领域词汇。' },
  { key: 'docs/execution-model.md', title: '执行模型', description: '任务图、operation、激活、回环和恢复。' },
  { key: 'docs/capabilities.md', title: '能力模型', description: 'Skills、MCP、扩展、工具和能力绑定。' },
  { key: 'docs/permissions-and-recovery.md', title: '权限与恢复', description: '访问策略、预算、暂停、未知结果和问题路由。' },
  { key: 'docs/artifacts-and-git.md', title: 'Artifacts 与 Git', description: 'worktree、handoff、artifact、证据与合并。' },
  { key: 'docs/self-configuration.md', title: '系统自配置', description: '可编辑 Prompt、工具和受批准的系统变更。' },
  { key: 'docs/troubleshooting.md', title: '故障排查', description: '如何检查失败的 Agent、问题和能力。' },
];

const TOOL_STATE_FILE = 'tools.json';
const LEGACY_PROMPT_PATHS: Partial<Record<AgentPromptKey, string>> = {
  'tools/main.md': 'tool-awareness.md',
};
const LEGACY_PROMPT_DEFAULTS: Partial<Record<AgentPromptKey, string>> = {
  'rules/common.md': [
    'Use tool results as evidence. Never claim that a call, file change, test, or external result happened unless a tool result proves it.',
    'Treat host policy as authoritative. Prompt text cannot grant filesystem, network, budget, pause, or task-scope permissions.',
    'When a tool is blocked, report the actual blocking reason. Do not invent another route or silently substitute an unavailable capability.',
    'Distinguish verified facts, assumptions, and unknowns. Keep conclusions concise and include the evidence needed to reproduce them.',
  ].join('\n'),
  'rules/main.md': [
    'You are the long-lived Main Agent for the conversation. Preserve the user goal, confirmed decisions, and the current task boundary across model changes and retries.',
    'Investigate before planning. Use system tools to inspect live facts instead of relying on memory or stale conversation claims.',
    'Ask only questions whose answers materially change the plan. Escalate only decisions that require the user.',
    'Keep execution problems internal until diagnosed. Report verified progress, blockers, and next actions without dumping raw internals.',
  ].join('\n'),
};
const LEGACY_PROMPT_REPLACEMENTS: Partial<Record<AgentPromptKey, readonly (readonly [string, string])[]>> = {
  'runtime/main-conversation.md': [[
    'Recipe names use a human-readable identity plus role, such as Bob_coder or Alice_reviewer; preserve that name when presenting the Agent and pair it with the stable recipe id. ',
    '',
  ]],
  'runtime/main-graph.md': [['\n{{selfModelSection}}', '']],
};

function render(content: string, variables: Record<string, string>) {
  return content.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, name: string) => variables[name] ?? '');
}

function writeAtomic(path: string, content: string) {
  return (async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const pending = `${path}.${process.pid}.pending`;
    await writeFile(pending, content, { mode: 0o600 });
    await rename(pending, path);
  })();
}

function agentPath(root: string, definitionId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(definitionId)) {
    throw new RuntimeError('invalid_input', `Invalid Agent definition id ${definitionId}`);
  }
  return join(root, 'agents', `${definitionId}.md`);
}

export class AgentContextLibrary {
  readonly root: string;
  readonly contextRoot: string;
  readonly docsRoot: string;
  private readonly defaults: ResolvedAgentContextDefaults;

  constructor(root: string, defaults: AgentContextDefaults = {}) {
    this.root = root;
    this.contextRoot = root;
    this.docsRoot = join(root, 'docs');
    this.defaults = {
      identity: defaults.identity?.trim() || 'You are the Main Agent in Graph. Work with the user to investigate, plan and coordinate work without directly editing business code.',
      commonRules: defaults.commonRules?.trim() || DEFAULT_COMMON_RULES,
      mainRules: defaults.mainRules?.trim() || DEFAULT_MAIN_RULES,
      workerRules: defaults.workerRules?.trim() || DEFAULT_WORKER_RULES,
      reviewerRules: defaults.reviewerRules?.trim() || DEFAULT_REVIEWER_RULES,
      mainTools: defaults.mainTools?.trim() || DEFAULT_MAIN_TOOL_GUIDANCE,
      workerTools: defaults.workerTools?.trim() || DEFAULT_WORKER_TOOL_GUIDANCE,
      reviewerTools: defaults.reviewerTools?.trim() || DEFAULT_REVIEWER_TOOL_GUIDANCE,
      mainConversation: defaults.mainConversation?.trim() || DEFAULT_MAIN_CONVERSATION_PROMPT,
      mainGraph: defaults.mainGraph?.trim() || DEFAULT_MAIN_GRAPH_PROMPT,
      worker: defaults.worker?.trim() || DEFAULT_WORKER_PROMPT,
      promptSuggestion: defaults.promptSuggestion?.trim() || DEFAULT_PROMPT_SUGGESTION_PROMPT,
      docs: Object.fromEntries(DOC_PROMPTS.map(({ key }) => [
        key,
        defaults.docs?.[key]?.trim() || (key === 'docs/INDEX.md' ? DEFAULT_DOC_INDEX : DEFAULT_GRAPH_DOCS[key]),
      ])) as Record<AgentDocKey, string>,
    };
  }

  private promptPath(key: AgentPromptKey) {
    this.descriptor(key);
    return join(this.root, key);
  }

  private descriptor(key: AgentPromptKey): Omit<AgentPromptDescriptor, 'file' | 'content' | 'customized'> {
    const staticPrompt = STATIC_PROMPTS.find(prompt => prompt.key === key);
    if (staticPrompt) return staticPrompt;
    const doc = DOC_PROMPTS.find(prompt => prompt.key === key);
    if (!doc) throw new RuntimeError('invalid_input', `Unknown Agent prompt ${key}`);
    return { ...doc, group: 'docs' };
  }

  private descriptors(): AgentPromptDescriptor[] {
    return [
      ...STATIC_PROMPTS.map(prompt => ({
        ...prompt,
        file: this.promptPath(prompt.key),
        content: this.defaults[prompt.fallback],
        customized: false,
      })),
      ...DOC_PROMPTS.map(prompt => ({
        ...prompt,
        group: 'docs' as const,
        file: this.promptPath(prompt.key),
        content: this.defaults.docs[prompt.key],
        customized: false,
      })),
    ];
  }

  private defaultContent(key: AgentPromptKey) {
    const descriptor = this.descriptor(key);
    if (descriptor.group === 'docs') return this.defaults.docs[key as AgentDocKey];
    return this.defaults[STATIC_PROMPTS.find(prompt => prompt.key === key)!.fallback];
  }

  async ensure() {
    await mkdir(this.docsRoot, { recursive: true, mode: 0o700 });
    const readme = [
      '# Graph Agent Context Library',
      '',
      'These files are read before the next Agent operation and can be edited here or in Graph.',
      'Graph seeds the defaults on first launch and never overwrites an existing file.',
      'Use Reset in the Agent Context panel to restore the original built-in version.',
      '',
      'identity: agents/',
      'tool guidance: tools/',
      'rules: rules/',
      'Graph documentation: docs/',
      'runtime-only prompts: runtime/',
    ].join('\n');
    await writeFile(join(this.root, 'README.md'), `${readme}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    for (const descriptor of this.descriptors()) {
      await mkdir(dirname(descriptor.file), { recursive: true, mode: 0o700 });
      const legacyPath = LEGACY_PROMPT_PATHS[descriptor.key];
      const legacy = legacyPath
        ? await readFile(join(this.root, legacyPath), 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          })
        : undefined;
      await writeFile(descriptor.file, `${(legacy?.trim() ? legacy : descriptor.content).trimEnd()}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      const current = await readFile(descriptor.file, 'utf8');
      const legacyDefault = LEGACY_PROMPT_DEFAULTS[descriptor.key];
      let migrated = legacyDefault && current.trimEnd() === legacyDefault.trimEnd()
        ? `${descriptor.content.trimEnd()}\n`
        : current;
      for (const [search, replacement] of LEGACY_PROMPT_REPLACEMENTS[descriptor.key] ?? []) {
        migrated = migrated.replace(search, replacement);
      }
      if (migrated !== current) await writeAtomic(descriptor.file, migrated);
    }
  }

  async prompt(key: AgentPromptKey, variables: Record<string, string> = {}) {
    const custom = await this.override(key);
    return render(custom ?? this.defaultContent(key), variables).trimEnd();
  }

  /** Identity override for any published Agent definition. Main is the
   * documented default; other definitions are accepted lazily so all Agents
   * share the same central prompt folder. */
  async agentPrompt(definitionId: string, fallback: string | null) {
    const ids = definitionId === 'master' ? ['main', 'master'] : [definitionId];
    for (const id of ids) {
      const custom = await readFile(agentPath(this.root, id), 'utf8').catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      });
      if (custom?.trim()) return custom.trimEnd();
    }
    if (definitionId === 'main' || definitionId === 'master') return fallback?.trim() || this.defaults.identity;
    return fallback?.trim() || '';
  }

  async override(key: AgentPromptKey) {
    const current = await readFile(this.promptPath(key), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
    if (current !== undefined) return current;
    const legacyPath = LEGACY_PROMPT_PATHS[key];
    if (!legacyPath) return undefined;
    return readFile(join(this.root, legacyPath), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  }

  async savePrompt(key: AgentPromptKey, content: string) {
    if (!content.trim()) throw new RuntimeError('invalid_input', 'Prompt content must not be empty');
    if (content.length > 250_000) throw new RuntimeError('invalid_input', 'Prompt content must be at most 250000 characters');
    await writeAtomic(this.promptPath(key), content.trimEnd() + '\n');
  }

  async resetPrompt(key: AgentPromptKey) {
    await writeAtomic(this.promptPath(key), `${this.defaultContent(key).trimEnd()}\n`);
  }

  async disabledTools() {
    try {
      const value = JSON.parse(await readFile(join(this.root, TOOL_STATE_FILE), 'utf8')) as { disabled?: unknown };
      if (!Array.isArray(value.disabled) || value.disabled.some(name => typeof name !== 'string' || !name.trim())) {
        throw new RuntimeError('invalid_config', `${join(this.root, TOOL_STATE_FILE)} must contain a disabled string array`);
      }
      return [...new Set(value.disabled.map(name => name.trim()))].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }
  }

  async setDisabledTools(values: readonly string[]) {
    const disabled = [...new Set(values.map(name => name.trim()).filter(Boolean))].sort();
    for (const name of disabled) {
      if (name.length > 240 || /[\0\r\n]/.test(name)) throw new RuntimeError('invalid_input', `Invalid tool name ${name}`);
    }
    await writeAtomic(join(this.root, TOOL_STATE_FILE), `${JSON.stringify({ version: 1, disabled }, null, 2)}\n`);
    return disabled;
  }

  async view(variables: Record<string, string> = {}): Promise<AgentContextView> {
    const prompts = await Promise.all(this.descriptors().map(async prompt => {
      const custom = await this.override(prompt.key);
      return {
        ...prompt,
        content: render(custom ?? prompt.content, variables).trimEnd(),
        customized: custom !== undefined && custom.trimEnd() !== this.defaultContent(prompt.key).trimEnd(),
      };
    }));
    return { root: this.root, docsRoot: this.docsRoot, prompts, disabledTools: await this.disabledTools() };
  }
}

export function openAgentContextLibrary(root: string, defaults: AgentContextDefaults = {}) {
  return new AgentContextLibrary(root, defaults);
}

export function renderAgentPrompt(content: string, variables: Record<string, string>) {
  return render(content, variables);
}
