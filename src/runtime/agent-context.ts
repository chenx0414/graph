import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

export const DEFAULT_MAIN_CONVERSATION_PROMPT = [
  'You are the master agent in an ongoing conversation with the user. Understand the goal, investigate the project with the read-only tools, compare options, and ask only questions whose answers change the plan. Do not modify files, run implementation commands, or claim work is done.',
  'propose_graph creates a draft version for the user to confirm; nothing is dispatched before confirmation. When the user changes direction, propose a new draft instead of arguing for the old one (only the latest draft on the current requirement can be confirmed).',
  'Each proposal should include a short decisions list of the binding constraints the user confirmed (for example "do not touch login.ts"); update or drop entries when the user revises them. The list is frozen with the draft and shown on the confirmation card, so workers receive exactly what the user reviewed.',
  'After confirmation the graph runs as a separate feature task. Answer progress questions from the "Conversation and execution status" section of the briefing with concrete recorded facts; when the user wants to change confirmed scope, explain the impact and require an explicit new task or confirmed change.',
  'Before proposing a graph, inspect the project and query the user capability directory with search_resources/get_resource. get_resource accepts a capability id or id@version, such as agent-browser-native or agent-browser-native@0.6.13. Search is discovery only; once a capability is bound into the Agent definition, its tools are available under the default capability-bypass runtime policy. Never invent capabilities from memory.',
  'Use list_agent_combinations/get_agent_combination to inspect recipes assembled from existing capability IDs. Recipe names use a human-readable identity plus role, such as Bob_coder or Alice_reviewer; preserve that name when presenting the Agent and pair it with the stable recipe id. Call get_agent_combination with the recipe id only, such as coder, not get_resource with an Agent definition version such as coder@5. You may save or edit recipes and compile them directly.',
  'You can inspect and improve Graph itself without a bound project. Use inspect_graph_system/read_system_capabilities for live self-awareness. {{fullAccessInstruction}}',
  'You have read-only access to existing capability bundles under the configured capability root. Use that access to inspect manifests and files before proposing a change. Direct capability writes remain forbidden; install or update only through propose_system_change and, after approval, apply_system_change.',
  'You also have read-only access to the running Graph application/source tree reported as application.root by read_system_capabilities. Inspect it to diagnose runtime and configuration problems and to prepare precise fixes; direct source edits remain forbidden.',
  'If the system pulse shows invalid capabilities, failed nodes, open internal problems or pending system changes, inspect them before making unrelated planning claims. When a concrete defect is actionable, explain the evidence and propose a bounded system change instead of silently changing the system.',
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
  '{{selfModelSection}}',
].join('\n');

export const DEFAULT_WORKER_PROMPT = 'Use workspace tools to read and edit files. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.{{retrievalNote}}';

export const DEFAULT_PROMPT_SUGGESTION_PROMPT = [
  'Write exactly one concise next message the user may want to send.',
  'Use the same language as the user message.',
  'Return only that message. Do not explain, quote, label, or mention suggestions or the composer.',
  'If there is no useful next message, return an empty string.',
].join(' ');

export interface AgentContextDefaults {
  identity?: string;
  toolAwareness?: string;
  mainConversation?: string;
  mainGraph?: string;
  worker?: string;
  promptSuggestion?: string;
}

export interface AgentPromptDescriptor {
  key: AgentPromptKey;
  title: string;
  description: string;
  file: string;
  content: string;
  customized: boolean;
}

export interface AgentContextView {
  root: string;
  prompts: AgentPromptDescriptor[];
  disabledTools: string[];
}

export type AgentPromptKey =
  | 'agents/main.md'
  | 'tool-awareness.md'
  | 'runtime/main-conversation.md'
  | 'runtime/main-graph.md'
  | 'runtime/worker.md'
  | 'runtime/prompt-suggestion.md';

const PROMPTS: readonly {
  key: AgentPromptKey;
  title: string;
  description: string;
  fallback: keyof AgentContextDefaults;
}[] = [
  { key: 'agents/main.md', title: 'Main Agent 身份', description: '作为 Pi system prompt 注入的身份与职责。', fallback: 'identity' },
  { key: 'tool-awareness.md', title: '能力感知', description: '追加到 system prompt 的能力使用说明；实际工具清单仍由 Graph 生成。', fallback: 'toolAwareness' },
  { key: 'runtime/main-conversation.md', title: 'Main Agent 对话规则', description: '讨论、规划、问题分流和共享产物等运行时指令。', fallback: 'mainConversation' },
  { key: 'runtime/main-graph.md', title: '任务图与工具调用规则', description: 'Main Agent 的 proposal schema 和运行时工具使用说明。', fallback: 'mainGraph' },
  { key: 'runtime/worker.md', title: 'Worker 运行规则', description: '普通实现、审查和验证 Agent 的运行时指令。', fallback: 'worker' },
  { key: 'runtime/prompt-suggestion.md', title: '输入建议生成', description: '生成下一条输入建议时使用的独立 system prompt。', fallback: 'promptSuggestion' },
];

const TOOL_STATE_FILE = 'tools.json';

function assertPromptKey(value: string): asserts value is AgentPromptKey {
  if (!PROMPTS.some(prompt => prompt.key === value)) throw new RuntimeError('invalid_input', `Unknown Agent prompt ${value}`);
}

function toolStatePath(root: string) {
  return join(root, TOOL_STATE_FILE);
}

function promptPath(root: string, key: AgentPromptKey) {
  assertPromptKey(key);
  return join(root, key);
}

function agentPath(root: string, definitionId: string) {
  if (!/^[a-z0-9][a-z0-9._-]{0,159}$/.test(definitionId)) {
    throw new RuntimeError('invalid_input', `Invalid Agent definition id ${definitionId}`);
  }
  return join(root, 'agents', `${definitionId}.md`);
}

function render(content: string, variables: Record<string, string>) {
  return content.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, name: string) => variables[name] ?? '');
}

async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pending = `${path}.${process.pid}.pending`;
  await writeFile(pending, content, { mode: 0o600 });
  await rename(pending, path);
}

export class AgentContextLibrary {
  readonly root: string;
  private readonly defaults: Required<AgentContextDefaults>;

  constructor(root: string, defaults: AgentContextDefaults = {}) {
    this.root = root;
    this.defaults = {
      identity: defaults.identity?.trim() || 'You are the Main Agent in Graph. Work with the user to investigate, plan and coordinate work without directly editing business code.',
      toolAwareness: defaults.toolAwareness?.trim() || 'Use only the callable tools listed in the generated capability inventory.',
      mainConversation: defaults.mainConversation?.trim() || DEFAULT_MAIN_CONVERSATION_PROMPT,
      mainGraph: defaults.mainGraph?.trim() || DEFAULT_MAIN_GRAPH_PROMPT,
      worker: defaults.worker?.trim() || DEFAULT_WORKER_PROMPT,
      promptSuggestion: defaults.promptSuggestion?.trim() || DEFAULT_PROMPT_SUGGESTION_PROMPT,
    };
  }

  async ensure() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const readme = [
      '# Graph Agent Prompt Library',
      '',
      'These files are read before the next Agent operation and can be edited here or in Graph.',
      'Graph seeds the defaults on first launch and never overwrites an existing file.',
      '',
      ...PROMPTS.map(prompt => `- ${prompt.key}: ${prompt.description}`),
      '- agents/<definition-id>.md: optional identity override for any other compiled Agent definition such as coder or reviewer.',
    ].join('\n');
    await writeFile(join(this.root, 'README.md'), `${readme}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    for (const prompt of PROMPTS) {
      const path = promptPath(this.root, prompt.key);
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, `${this.defaults[prompt.fallback].trimEnd()}\n`, { mode: 0o600, flag: 'wx' }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    }
  }

  async prompt(key: AgentPromptKey, variables: Record<string, string> = {}) {
    const custom = await this.override(key);
    const template = custom ?? this.defaults[PROMPTS.find(prompt => prompt.key === key)!.fallback];
    return render(template, variables).trimEnd();
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
    return readFile(promptPath(this.root, key), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    });
  }

  async savePrompt(key: AgentPromptKey, content: string) {
    if (!content.trim()) throw new RuntimeError('invalid_input', 'Prompt content must not be empty');
    if (content.length > 250_000) throw new RuntimeError('invalid_input', 'Prompt content must be at most 250000 characters');
    await writeAtomic(promptPath(this.root, key), content.trimEnd() + '\n');
  }

  async disabledTools() {
    try {
      const value = JSON.parse(await readFile(toolStatePath(this.root), 'utf8')) as { disabled?: unknown };
      if (!Array.isArray(value.disabled) || value.disabled.some(name => typeof name !== 'string' || !name.trim())) {
        throw new RuntimeError('invalid_config', `${toolStatePath(this.root)} must contain a disabled string array`);
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
    await writeAtomic(toolStatePath(this.root), `${JSON.stringify({ version: 1, disabled }, null, 2)}\n`);
    return disabled;
  }

  async view(variables: Record<string, string> = {}): Promise<AgentContextView> {
    const prompts = await Promise.all(PROMPTS.map(async prompt => {
      const custom = await this.override(prompt.key);
      const defaults = this.defaults[prompt.fallback];
      const template = custom ?? defaults;
      return {
        key: prompt.key,
        title: prompt.title,
        description: prompt.description,
        file: promptPath(this.root, prompt.key),
        content: render(template, variables).trimEnd(),
        customized: custom !== undefined && custom.trimEnd() !== defaults.trimEnd(),
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
