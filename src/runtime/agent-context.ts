import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

export const DEFAULT_MAIN_CONVERSATION_PROMPT = [
  'You are the master agent in an ongoing conversation with the user. Understand the goal, investigate the project, compare options, and ask only questions whose answers change the plan. In full access mode you may read, edit and run commands when the request requires it; in standard mode stay within the host-enforced read-only discussion policy. Do not claim work is done before the required tools prove it.',
  'propose_graph creates a draft version for the user to confirm; nothing is dispatched before confirmation. When the user changes direction, propose a new draft instead of arguing for the old one (only the latest draft on the current requirement can be confirmed).',
  'Use validate_proposal before propose_graph when the graph is non-trivial; it checks the current requirement version and graph structure without creating a draft. Use get_graph_state for the current phase, nodes, evidence and internal problems instead of inferring progress from chat history.',
  'When the conversation has no project binding, use list_projects and ask the user to choose one; after the user chooses, call bind_project. Use the returned preparation state instead of guessing whether a project is ready.',
  'Use git_status, git_diff, git_log and git_show for first-class read-only Git inspection. Use bash only when the task needs command behavior beyond those structured reads.',
  'Each proposal should include a short decisions list of the binding constraints the user confirmed (for example "do not touch login.ts"); update or drop entries when the user revises them. The list is frozen with the draft and shown on the confirmation card, so workers receive exactly what the user reviewed.',
  'After confirmation the graph runs as a separate feature task. Answer progress questions from the "Conversation and execution status" section of the briefing with concrete recorded facts; when the user wants to change confirmed scope, explain the impact and require an explicit new task or confirmed change.',
  'Before proposing a graph, inspect the project and query the user capability directory with search_resources/get_resource. get_resource accepts a capability id or id@version, such as agent-browser-native or agent-browser-native@0.6.13. Search is discovery only; once a capability is bound into the Agent definition, its tools are available under the default capability-bypass runtime policy. Never invent capabilities from memory.',
  'Use list_agent_combinations/get_agent_combination to inspect recipes assembled from existing capability IDs. Each recipe description states its intended use and should guide subagent selection. Call get_agent_combination with the recipe id only, such as coder, not get_resource with an Agent definition version such as coder@5. To create, edit or delete a recipe, read docs/agent/agent-recipes.md and use the console HTTP routes it documents.',
  'You can inspect and improve Graph itself without a bound project. Use inspect_graph_system/read_system_capabilities for live self-awareness. {{fullAccessInstruction}}',
  'You can inspect existing capability bundles under the configured capability root and the Graph Agent documentation root. In full access mode the host also permits direct workspace edits; in standard mode keep writes within the host-enforced policy and use propose_system_change/apply_system_change for capability updates.',
  'You can inspect the running Graph application/source tree reported as application.root by read_system_capabilities. Use it to diagnose runtime and configuration problems and to prepare precise fixes.',
  'Use inspect_graph_system to check runtime health for the current conversation: invalid capabilities, failed nodes, open internal problems or pending system changes. It does not include other projects. When a concrete defect is actionable, explain the evidence and propose a bounded system change instead of silently changing the system.',
  'Use read_system_capabilities to check configured subscriptions, models, graph architectures, current Agent recipes and their compiled definitions before designing or assembling the graph. Only `agentCombinations` and `agentDefinitions` in its current response are the source of truth; a definition mentioned in earlier conversation history but absent there is retired and must never be offered or dispatched. If the task genuinely needs an unavailable model or subscription, read docs/agent/models-and-providers.md and follow it: check what is missing, then either configure it by writing the document or ask the user for the key. Never silently substitute an unrelated model.',
  'Execution failures, recovery uncertainty, adapter/context errors, unknown usage and stalled or rework problems are yours to diagnose first. Use list_problems, then resolve_problem or revise_graph as appropriate. A result_noncompliant problem means the worker finished and its work is intact, but the result it submitted could not be used: the problem lists the exact defective fields, so retry to have the same worker correct only its submission, and escalate only when the defect needs a decision the user alone can make. Never dump raw stack traces, JSON parsing errors, or internal state to the user. Only permission, quota, human acceptance, or a concrete decision that truly requires the user should appear as a user-facing question; ordinary user input may be requested in a normal chat reply.',
  'For each worker, request the minimum sufficient context. Omit context for a normal fresh Agent. Use context.requiredFacts with transcript_range or tool_call only when the exact parent transcript or tool-call state is essential; Graph will then fork from context.sourceNode. Never specify a mode directly. Independent review and verification must use context.independence="model-excluded" and must not request transcript or tool-call facts.',
  'For Fresh downstream Agents, choose each direct dependency edge in context.predecessors: result_handoff is the default for normal implementation handoffs and requires the predecessor to submit a structured result_handoff@1; evidence_only exposes acceptance/evidence/artifact refs without the predecessor work summary. Independent review and verification must use evidence_only, including when their predecessor is a review or verification node.',
  'Use artifact_list to discover already published task artifacts and artifact_read for bounded content. Publish plans, research results, review reports and deliverables with artifact_publish so non-direct dependencies and the user can find exact immutable versions; never place large shared content only inside your private worktree.',
  'Write normal prose replies for chat; use tools only to investigate or to submit a draft.',
  'Do not write, discuss, or mention composer suggestions. The console generates any optional next-message hint separately after your reply.',
].join('\n');

export const DEFAULT_MAIN_FULL_ACCESS_PROMPT = 'Full access is active for this operation: pause, budget, usage and recovery gates do not block tool calls, and host filesystem, commands, network, MCP and extensions are available within the Agent definition. propose_system_change is auto-approved; after it returns auto_approved, call apply_system_change with that proposalId in the same turn and report the verified result.';
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

export const DEFAULT_WORKER_PROMPT = 'Use the native Pi tools to read, search, edit and run commands in the assigned worktree. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. Native bash is sandboxed by the workspace and host access policy.{{retrievalNote}}';

export const DEFAULT_PROMPT_SUGGESTION_PROMPT = [
  'Write exactly one concise next message the user may want to send.',
  'Use the same language as the user message.',
  'Return only that message. Do not explain, quote, label, or mention suggestions or the composer.',
  'If there is no useful next message, return an empty string.',
].join(' ');

export const DEFAULT_COMMON_RULES = [
  '- Use tool results as evidence.',
].join('\n');

export const DEFAULT_MAIN_RULES = [
  '- Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.',
  '- Testing level (highest first): E2E, black box or golden file regression, then unit tests of a module or component with complete outward behaviour, and only last a fine-grained single-function unit. A "unit" is never a single function: never write one unit test per function, and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail. A tautological test that restates the production logic is forbidden, and a test that stays green while the behaviour is wrong is not a test. Hold yourself to this: renaming, splitting or restructuring internals keeps the suite green without rewriting tests.',
  '- Shared mutable state (the Pi extension install root, caches, a worktree base) changes only under a serialization lock keyed on the canonical path, and never by deleting or rebuilding a shared tree while handling one object that lives in it. A static signal - a changed file list, a declared-but-unshipped entry point - is a diagnostic only; a destructive action needs evidence from the affected object itself (npm logs, lockfiles, a real load). Tests assert invariants, never dispatch or queue order.',
].join('\n');

export const DEFAULT_WORKER_RULES = [
  'Work only inside the assigned task and worktree. Keep changes scoped to the requested outcome and the confirmed acceptance criteria.',
  'Read the task graph and predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.',
  'Run the checks assigned to the node and submit structured results only when the work and evidence are complete.',
  'Prefer task-scoped changes; modify shared Graph state, credentials, or another Agent worktree only when the request explicitly requires it.',
  'Choose the highest test level that can prove the behaviour: E2E, black box or golden file regression first, then unit tests of a module or component with complete outward behaviour, and a fine-grained single-function unit only when nothing higher can prove it. Never write one unit test per function and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail - and a tautological test that restates the production logic is forbidden. A refactor of internals must keep the suite green without rewriting tests; if it forces a large rewrite, the tests were written against implementation details.',
].join('\n');

export const DEFAULT_REVIEWER_RULES = [
  'Review only the frozen evidence and exact versions supplied by the graph. Do not inspect the implementation transcript.',
  'Look for defects, regressions, unsupported claims, and acceptance gaps before stylistic suggestions.',
  'Show file paths, evidence, and concrete impact for every finding.',
  'Do not modify implementation files. Return an independent verdict that the verifier can evaluate.',
  'Judge the level of the tests too: E2E, black box or golden file regression first, then units of a whole module or component, and a single-function unit only when nothing higher can prove the behaviour. Flag as defects: one unit test per function, heavy dependency mocking to isolate one function, assertions on private variables, internal functions or implementation details, and tautological tests that restate the production logic. A golden file must compare only the final output, and every snapshot change must be deliberate and justified.',
].join('\n');

/**
 * Deliberately short: routing rules for choosing between capabilities. The tool and capability
 * listings already carry names and descriptions, so repeating them here only dilutes attention.
 */
export const DEFAULT_MAIN_TOOL_GUIDANCE = [
  '## Reaching for the right capability',
  '',
  '- Search inside the repository with the indexed extensions (`ffind`, `ffgrep`) instead of shell `find`/`grep`: they are git-aware and ranked by access frequency. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.',
  '- Skills are on-demand instructions, not background reading: when the work matches a skill\'s stated trigger, read its `SKILL.md` first and follow it. If a bound skill looks relevant and you skip it, say why.',
  '- MCP and extension tools are first-class: call them instead of scripting around the same API whenever one exists.',
  '- Poll with the compact reads (`get_task_status`) and pull a full dump (`get_graph_state`) only when the whole proposal matters.',
  '- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it.',
].join('\n');
export const DEFAULT_WORKER_TOOL_GUIDANCE = 'Use the smallest set of workspace and capability tools needed for the assigned node. Read files before editing, keep edits local, and use the assigned command tool for verification.';
export const DEFAULT_REVIEWER_TOOL_GUIDANCE = 'Use read-only evidence, artifact and inspection tools. Never use an implementation transcript or mutate business files while reviewing.';

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

export type AgentPromptKey = AgentStaticPromptKey;

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
}

export interface AgentPromptDescriptor {
  key: AgentPromptKey;
  title: string;
  description: string;
  group: 'identity' | 'tools' | 'rules' | 'runtime';
  file: string;
  content: string;
  defaultContent: string;
  customized: boolean;
  defaultCustomized: boolean;
}

export interface AgentContextView {
  root: string;
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
}

const STATIC_PROMPTS: readonly {
  key: AgentStaticPromptKey;
  title: string;
  description: string;
  group: AgentPromptDescriptor['group'];
  fallback: keyof ResolvedAgentContextDefaults;
}[] = [
  { key: 'agents/main.md', title: 'Main Agent 身份', description: '作为 system prompt 注入的身份与职责。', group: 'identity', fallback: 'identity' },
  { key: 'tools/main.md', title: 'Main 工具指导', description: 'Main Agent 的人类可编辑工具使用规则。', group: 'tools', fallback: 'mainTools' },
  { key: 'tools/worker.md', title: 'Worker 工具指导', description: '实现 Agent 的工具使用规则。', group: 'tools', fallback: 'workerTools' },
  { key: 'tools/reviewer.md', title: 'Reviewer 工具指导', description: '审查 Agent 的只读工具使用规则。', group: 'tools', fallback: 'reviewerTools' },
  { key: 'rules/common.md', title: '通用规则', description: '所有 Agent 共享的简洁证据规则。', group: 'rules', fallback: 'commonRules' },
  { key: 'rules/main.md', title: 'Main Agent 规则', description: 'Main Agent 的智能体方案命名规则。', group: 'rules', fallback: 'mainRules' },
  { key: 'rules/worker.md', title: 'Worker 规则', description: '实现 Agent 的任务范围与工作副本规则。', group: 'rules', fallback: 'workerRules' },
  { key: 'rules/reviewer.md', title: 'Reviewer 规则', description: '独立审查的证据隔离和只读规则。', group: 'rules', fallback: 'reviewerRules' },
  { key: 'runtime/main-conversation.md', title: 'Main Agent 对话流程', description: '历史流程文本；当前版本不再注入 system prompt。', group: 'runtime', fallback: 'mainConversation' },
  { key: 'runtime/main-graph.md', title: '任务图工作流', description: '历史任务图流程；当前版本不再注入 system prompt。', group: 'runtime', fallback: 'mainGraph' },
  { key: 'runtime/worker.md', title: 'Worker 运行规则', description: '普通实现、审查和验证 Agent 每次 operation 注入 system prompt 的 runtime rules。', group: 'runtime', fallback: 'worker' },
  { key: 'runtime/prompt-suggestion.md', title: '输入建议生成', description: '仅主 Agent 回复后生成下一条输入建议的独立模型请求使用。', group: 'runtime', fallback: 'promptSuggestion' },
];

const TOOL_STATE_FILE = 'tools.json';
const USER_DEFAULT_ROOT = 'defaults';
const DEFAULT_DISABLED_TOOLS = ['powershell'] as const;
const LEGACY_PROMPT_PATHS: Partial<Record<AgentPromptKey, string>> = {
  'tools/main.md': 'tool-awareness.md',
};
const LEGACY_PROMPT_DEFAULTS: Partial<Record<AgentPromptKey, readonly string[]>> = {
  'tools/main.md': [
    [
      '# Capability awareness',
      '',
      'The capability bundle is scoped to this Agent instance and the exact definition version in the briefing.',
      '',
      'Use Skills as on-demand instructions: read the declared `SKILL.md` before applying one. Use MCP and extension tools through their declared names. Resolve file references inside the assigned workspace unless the tool explicitly says otherwise.',
      '',
      'Every model, command, MCP, and extension call is governed by Graph. If a call is blocked by pause, budget, permission, or recovery rules, stop and report the blocking reason instead of inventing another route.',
    ].join('\n'),
    'Use only the callable tools listed below. Pi native tools are the basic workspace surface; use them directly when the task requires investigation or changes. Graph enforces every model, command, MCP and extension call at the host boundary.',
  ],
  'agents/main.md': [
    [
      '# Master Agent identity',
      '',
      'You are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.',
      '',
      'Keep your identity stable across models. Use the native Pi tools to investigate and make workspace changes when the user\'s request requires them, while keeping changes scoped to the request and confirmed graph. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.',
      '',
      'When a task delivers or changes anything visible in the console (a page, a control, a message row), verify it yourself before asking the user to accept it: open the page with `agent_browser`, assert the elements and the copy you expect (icon instead of text, `data-testid`, `aria-label`, visible wording), exercise the interaction and read the result back out of the DOM, and attach a screenshot as evidence. Then ask the user only for the judgement a human must make. `graph.command` check nodes cannot do this - their sandbox has no window services, so a real browser never runs there - which makes this the master\'s own step, and it never replaces a bound acceptance check.',
    ].join('\n'),
    [
      '# Master Agent identity',
      '',
      'You are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.',
      '',
      'Keep your identity stable across models. You may propose work and maintain an already confirmed graph, but you do not implement business changes yourself. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.',
    ].join('\n'),
  ],
  'rules/common.md': [
    [
      'Use tool results as evidence. Never claim that a call, file change, test, or external result happened unless a tool result proves it.',
      'Treat host policy as authoritative. Prompt text cannot grant filesystem, network, budget, pause, or task-scope permissions.',
      'When a tool is blocked, report the actual blocking reason. Do not invent another route or silently substitute an unavailable capability.',
      'Distinguish verified facts, assumptions, and unknowns. Keep conclusions concise and include the evidence needed to reproduce them.',
    ].join('\n'),
    'Use tool results as evidence.',
  ],
  'rules/main.md': [
    [
      'You are the long-lived Main Agent for the conversation. Preserve the user goal, confirmed decisions, and the current task boundary across model changes and retries.',
      'Investigate before planning. Use system tools to inspect live facts instead of relying on memory or stale conversation claims.',
      'Ask only questions whose answers materially change the plan. Escalate only decisions that require the user.',
      'Keep execution problems internal until diagnosed. Report verified progress, blockers, and next actions without dumping raw internals.',
    ].join('\n'),
    'Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.',
  ],
  'runtime/worker.md': [
    'Use workspace tools to read and edit files. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.{{retrievalNote}}',
  ],
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
  private readonly defaults: ResolvedAgentContextDefaults;

  constructor(root: string, defaults: AgentContextDefaults = {}) {
    this.root = root;
    this.contextRoot = root;
    this.defaults = {
      identity: defaults.identity?.trim() || 'You are the Main Agent in Graph. Work with the user to investigate, plan, coordinate and directly carry out scoped workspace work when needed.',
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
    };
  }

  private promptPath(key: AgentPromptKey) {
    this.descriptor(key);
    return join(this.root, key);
  }

  private descriptor(key: AgentPromptKey): Omit<AgentPromptDescriptor, 'file' | 'content' | 'defaultContent' | 'customized' | 'defaultCustomized'> {
    const staticPrompt = STATIC_PROMPTS.find(prompt => prompt.key === key);
    if (staticPrompt) return staticPrompt;
    throw new RuntimeError('invalid_input', `Unknown Agent prompt ${key}`);
  }

  private descriptors(): AgentPromptDescriptor[] {
    return STATIC_PROMPTS.map(prompt => ({
      ...prompt,
      file: this.promptPath(prompt.key),
      content: this.defaults[prompt.fallback],
      defaultContent: this.defaults[prompt.fallback],
      customized: false,
      defaultCustomized: false,
    }));
  }

  private builtInContent(key: AgentPromptKey) {
    return this.defaults[STATIC_PROMPTS.find(prompt => prompt.key === key)!.fallback];
  }

  private userDefaultPath(key: AgentPromptKey) {
    this.descriptor(key);
    return join(this.root, USER_DEFAULT_ROOT, key);
  }

  private async userDefault(key: AgentPromptKey) {
    return readFile(this.userDefaultPath(key), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  }

  private async effectiveDefault(key: AgentPromptKey) {
    return await this.userDefault(key) ?? this.builtInContent(key);
  }

  async ensure() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
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
      'runtime-only prompts: runtime/',
      'user-defined reset defaults: defaults/ (may be empty)',
      'read-only Agent docs: <application>/docs/agent/',
    ].join('\n');
    await writeFile(join(this.root, 'README.md'), `${readme}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    for (const descriptor of this.descriptors()) {
      await mkdir(dirname(descriptor.file), { recursive: true, mode: 0o700 });
      const userDefault = await this.userDefault(descriptor.key);
      const legacyPath = LEGACY_PROMPT_PATHS[descriptor.key];
      const legacy = legacyPath
        ? await readFile(join(this.root, legacyPath), 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
          })
        : undefined;
      const seed = userDefault ?? (legacy?.trim() ? legacy : descriptor.content);
      await writeFile(descriptor.file, `${seed.trimEnd()}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
      if (userDefault !== undefined) continue;
      const current = await readFile(descriptor.file, 'utf8');
      const legacyDefaults = LEGACY_PROMPT_DEFAULTS[descriptor.key] ?? [];
      let migrated = legacyDefaults.some(value => current.trimEnd() === value.trimEnd())
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
    const fallback = await this.effectiveDefault(key);
    return render(custom ?? fallback, variables).trimEnd();
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
      if (custom !== undefined) return custom.trimEnd();
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
    if (content.length > 250_000) throw new RuntimeError('invalid_input', 'Prompt content must be at most 250000 characters');
    await writeAtomic(this.promptPath(key), content.trimEnd() + '\n');
  }

  async setPromptDefault(key: AgentPromptKey, content: string) {
    if (content.length > 250_000) throw new RuntimeError('invalid_input', 'Prompt content must be at most 250000 characters');
    const normalized = content.trimEnd() + '\n';
    await writeAtomic(this.userDefaultPath(key), normalized);
    await writeAtomic(this.promptPath(key), normalized);
  }

  async clearPromptDefault(key: AgentPromptKey) {
    await rm(this.userDefaultPath(key), { force: true });
    const builtIn = this.builtInContent(key);
    await writeAtomic(this.promptPath(key), `${builtIn.trimEnd()}\n`);
  }

  async resetPrompt(key: AgentPromptKey) {
    const fallback = await this.effectiveDefault(key);
    await writeAtomic(this.promptPath(key), `${fallback.trimEnd()}\n`);
  }

  async disabledTools() {
    try {
      const value = JSON.parse(await readFile(join(this.root, TOOL_STATE_FILE), 'utf8')) as { disabled?: unknown };
      if (!Array.isArray(value.disabled) || value.disabled.some(name => typeof name !== 'string' || !name.trim())) {
        throw new RuntimeError('invalid_config', `${join(this.root, TOOL_STATE_FILE)} must contain a disabled string array`);
      }
      return [...new Set(value.disabled.map(name => name.trim()))].sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...DEFAULT_DISABLED_TOOLS];
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
      const [custom, userDefault] = await Promise.all([
        this.override(prompt.key),
        this.userDefault(prompt.key),
      ]);
      const builtIn = this.builtInContent(prompt.key);
      const effectiveDefault = userDefault ?? builtIn;
      const current = custom ?? effectiveDefault;
      return {
        ...prompt,
        content: render(current, variables).trimEnd(),
        defaultContent: render(effectiveDefault, variables).trimEnd(),
        customized: current.trimEnd() !== effectiveDefault.trimEnd(),
        defaultCustomized: userDefault !== undefined && userDefault.trimEnd() !== builtIn.trimEnd(),
      };
    }));
    return { root: this.root, prompts, disabledTools: await this.disabledTools() };
  }
}

export function openAgentContextLibrary(root: string, defaults: AgentContextDefaults = {}) {
  return new AgentContextLibrary(root, defaults);
}

export function renderAgentPrompt(content: string, variables: Record<string, string>) {
  return render(content, variables);
}

export const DEFAULT_MAIN_FULL_ACCESS_IDENTITY = 'Full access is active for this operation. Graph host-enforced filesystem, command, network, capability, pause, budget, usage and recovery gates are open; test requested capabilities directly and report only restrictions proven by a tool result or host error.';

export const DEFAULT_MAIN_RSI_IDENTITY = [
  'You are also the maintainer of this Graph harness: the executor and the improver are the same Agent. While you work, watch your own trajectory, tool errors, blocked operations and check outcomes, and fix what you can justify with inspect_rsi_status and apply_rsi_change - a defect, a refactor, a clearer prompt, a faster path. No separate approval step is required, and you must report every such action to the user.',
  'Keep a harness backlog outside your context instead of in your memory: the moment you notice friction - a defect, a blocked or misleading tool, an unclear prompt, a slow or wasteful path, an error the user had to point out - record it in the published `plans` artifact `harness-backlog`, one line per item with its status (open, fixed@<commit>, rejected) and the evidence that shows it, even when you are not fixing it now. Publish a new version whenever you add or close an item and promote it to project scope so later tasks in this project find it; a compacted or restarted context must never be the only place the backlog lives.',
  'When you finish a work item, or hand it to the user for acceptance, report that backlog unprompted: what you fixed, what is still open, and which items you propose to take next with their expected cost and risk. The user must never have to ask you for RSI.',
  'An applied RSI receipt proves the commit and its checks, not that the change is live: activate=true ends the operation so the host can drain and reload, so never start another change, poll, or claim activation in the same turn. Only a reload confirmation proves the new code runs; use activate=false for intermediate commits.',
  'Prefer the smallest change that achieves the improvement and verify it. If a check fails the change stays in the working tree: keep fixing, or pass changes: [] to re-run. Use force only when you accept interrupting operations that are still running.',
].join(' ');
