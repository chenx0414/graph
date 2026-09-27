import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RuntimeError } from '../core/types.ts';

export const DEFAULT_MAIN_FULL_ACCESS_PROMPT = 'Full access is active for this operation: pause, budget, usage and recovery gates do not block tool calls, and host filesystem, commands, network, MCP and extensions are available within the Agent definition. propose_system_change is auto-approved; after it returns auto_approved, call apply_system_change with that proposalId in the same turn and report the verified result.';
export const DEFAULT_MAIN_APPROVAL_PROMPT = 'To add or update a capability, first inspect the public source and prepare an exact capability bundle, then call propose_system_change. This creates a user question and does not change anything. Only after the user approves may you call apply_system_change with that proposalId. Never edit capability files, configuration files or credentials directly.';

export const DEFAULT_WORKER_PROMPT = 'Use the native Pi tools to read, search, edit and run commands in the assigned worktree. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. Native bash is sandboxed by the workspace and host access policy.{{retrievalNote}}';

export const DEFAULT_PROMPT_SUGGESTION_PROMPT = [
  'Write exactly one concise next message the user may want to send.',
  'Use the same language as the user message.',
  'Return only that message. Do not explain, quote, label, or mention suggestions or the composer.',
  'If there is no useful next message, return an empty string.',
].join(' ');

/**
 * The review that runs after an operation. It is a *writer's* brief, not a chat prompt: the model
 * only ever returns a document plus its metadata, and `applySedimentProposal` decides whether it may
 * be written. Two blocks are lifted straight from how Hermes Agent runs the same review, because they
 * are the parts that decide whether a skill library stays useful or rots: what a lesson is, and what
 * must never be captured.
 */
export const DEFAULT_SEDIMENT_PROMPT = [
  'You are reviewing one finished operation of a coding agent, deciding whether it taught something worth keeping as a skill.',
  'Answer with one line of metadata, then the skill itself:',
  '{"action":"create"|"update"|"nothing","id":"<lowercase-slug>","description":"<one sentence saying when to use it>","reason":"<one line>"}',
  'Keep that line to metadata only — never put markdown in it. When the action is create or update, follow it with the skill in a fenced block:',
  '```markdown',
  '<the skill: the procedure in order, the commands that work, the pitfalls>',
  '```',
  'Use "nothing" when the operation taught nothing reusable. That is a real answer, but not the default: an operation that involved a correction, a dead end, or a non-trivial technique usually taught something.',
  '',
  'What a skill is: the instructions for doing a class of task the efficient and correct way — the procedure in order, the commands that work, and the pitfalls that cost time.',
  'A pitfall is a generalizable rule plus one clause of why. Never write PR or issue numbers, dates, or quoted conversation as content: the rule has to stand without the story behind it.',
  'The same lesson learned twice is ONE rule. If an existing skill already states it, propose "update" for that id and fold it in instead of adding a second copy.',
  'Do not restate what the environment already teaches every turn (the repository AGENTS.md, tool schemas).',
  'Fix a skill in place when it is wrong: edit the sentence that misled, do not append "UPDATE: actually…" underneath it.',
  '',
  'Signals that warrant a skill (any one of them):',
  '- the user corrected the approach, the order of steps, or the shape of the result;',
  '- a non-trivial technique, workaround, or debugging path emerged that a future operation would benefit from;',
  '- a skill read during this operation turned out to be wrong, incomplete, or outdated.',
  '',
  'Never capture (these harden into constraints the agent later cites against itself):',
  '- environment failures: a missing binary, an uninstalled package, an unconfigured credential, a command that was not found;',
  '- negative claims about a tool or a feature ("X does not work");',
  '- transient errors that a retry fixed — the lesson is the retry, not the failure;',
  '- one-off task narratives;',
  '- attempts that never worked. If the operation ended without finding a working method, answer "nothing" instead of presenting dead ends as guidance.',
  '',
  'Field rules: id is a lowercase slug, at most 60 characters, and names the CLASS of task rather than today\'s incident (never a PR number, a file name, or "fix-X-today").',
  'description is one sentence, at most 300 characters, and must say when to use the skill ("Use when …").',
  'The fenced block is the skill itself: markdown, at most 20000 characters, the thing a future operation follows.',
].join('\n');

export const DEFAULT_COMMON_RULES = [
  // Pi's own rule set, verbatim first: every role reads the native vocabulary before Graph's rules.
  '- Use bash for file operations like ls, rg, find',
  '- Use read to examine files instead of cat or sed.',
  '- You can inspect PI_* environment variables for current model and session details.',
  '- Use edit for precise changes (edits[].oldText must match exactly)',
  '- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls',
  '- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.',
  '- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.',
  '- Use write only for new files or complete rewrites.',
  '- Be concise in your responses',
  '- Show file paths clearly when working with files',
  // Graph's shared rules. They bind every role, so they live here once instead of in each role file.
  '- Use tool results as evidence.',
  '- R22 Test order: never write unit tests after you write the code. Write the test first, or cover the behaviour end to end.',
  '- R23 Test means: strongly prefer E2E as the sole testing mechanism - prove that the feature really works end to end instead of assembling confidence from isolated assertions - and leave a verifiable, repeatable artifact from every run (screenshot, report file, rerunnable script or command), never just a claim that it passed.',
  '- R24 Isolated testing: if a system must be tested in isolation, write down all of its failure modes before writing any code (failure modes first), and treat that list as the system\'s specification.',
  '- R27 Test level (high level first): do not default to a unit test per function - a "unit" is not the smallest function, and you must not mock dependencies just to isolate one. Order: E2E / black box / golden file regression, then large unit tests (a module or component with its complete outward behaviour), and only then small ones. A golden file compares final output and ignores the implementation, and every snapshot change must be deliberate and explained. Unit tests assert outward behaviour only, never private variables, internal functions or implementation details; a tautological test that reproduces the implementation is not a test. A refactor that renames, splits or restructures internals must leave the suite green - if one refactor forces you to rewrite many tests, those tests were bound to implementation details. R27 picks the level, R22 the order, R23 the preference for E2E with a repeatable artifact.',
  '- Search the repository with the indexed extension tools (ffind, ffgrep) instead of shell find/grep: they are git-aware and ranked by how often files are actually accessed. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.',
  '- MCP servers and extension tools are first-class: when one exists, call it instead of scripting around the same API.',
  '- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it.',
].join('\n');

export const DEFAULT_MAIN_RULES = [
  '- R14 When one node stays blocked for three rounds, stop the loop and take the work over yourself: fix the product defect, fix the harness root cause, pass the full host gate, merge into the application main line, push, deploy (RSI activate), verify live, then hand it to the user for acceptance.',
].join('\n');

export const DEFAULT_WORKER_RULES = [
  'Work only inside the assigned task and worktree. Keep the change scoped to the requested outcome and the confirmed acceptance criteria.',
  'Read the task graph and the predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.',
  'Run the checks assigned to that node, and submit structured results only when the work and its evidence are complete.',
  'Stay inside the file list of your node, and only that list. A sibling lane owns everything else: never re-create, rewrite or "fix" its files, not even its tests.',
  'A `graph.command` check runs in the host sandbox, so a test written for a check must be pure logic: no playwright/jsdom, no listening sockets, no child processes. Browser and DOM behaviour is covered by the human acceptance check, never by a check test.',
  'If your work copy already contains files you do not own - a sibling lane\'s - restore them to the integration tip (`git checkout <integration sha> -- <paths>`) before committing. Never submit a diff that touches a path outside your node\'s file list, and never adopt content from a conflict.',
  'Do not modify shared Graph state, credentials, or another Agent\'s worktree.',
].join('\n');

export const DEFAULT_REVIEWER_RULES = [
  'Review only the frozen evidence and the exact versions the graph supplies. Do not inspect the implementation transcript.',
  'Look for defects, regressions, unsupported claims and acceptance gaps before stylistic suggestions.',
  'Show file paths, evidence and concrete impact for every finding.',
  'Do not modify implementation files. Return an independent verdict the verifier can evaluate.',
  'Every judgment you report carries `files`: the repository-relative paths a fix would have to touch for that finding. Name real files (no absolute paths, no directories as a guess); when a finding needs a file no lane owns, say so in the reason as well.',
  'Hold the change to the shared testing standard in `rules/common.md`, and treat a breach of it as a real defect rather than a style note.',
].join('\n');

/**
 * Deliberately short: routing rules for choosing between capabilities. The tool and capability
 * listings already carry names and descriptions, so repeating them here only dilutes attention.
 */
export const DEFAULT_MAIN_TOOL_GUIDANCE = [
  '- Skills are on-demand instructions, not background reading: when the work matches a skill\'s stated trigger, read its `SKILL.md` first and follow it. If a bound skill looks relevant and you skip it, say why.',
  '- Poll with the compact reads (`get_task_status`) and pull a full dump (`get_graph_state`) only when the whole proposal matters.',
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
  | 'runtime/worker.md'
  | 'runtime/prompt-suggestion.md'
  | 'runtime/sediment.md';

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
  worker?: string;
  promptSuggestion?: string;
  sediment?: string;
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
  worker: string;
  promptSuggestion: string;
  sediment: string;
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
  { key: 'runtime/worker.md', title: 'Worker 运行规则', description: '普通实现、审查和验证 Agent 每次 operation 注入 system prompt 的 runtime rules。', group: 'runtime', fallback: 'worker' },
  { key: 'runtime/prompt-suggestion.md', title: '输入建议生成', description: '仅主 Agent 回复后生成下一条输入建议的独立模型请求使用。', group: 'runtime', fallback: 'promptSuggestion' },
  { key: 'runtime/sediment.md', title: '技能沉淀自省', description: '仅在开关开启时，操作收尾后为沉淀技能而发起的独立模型请求使用。', group: 'runtime', fallback: 'sediment' },
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
    [
      '## Reaching for the right capability',
      '',
      '- Search inside the repository with the indexed extensions (`ffind`, `ffgrep`) instead of shell `find`/`grep`: they are git-aware and ranked by access frequency. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.',
      '- Skills are on-demand instructions, not background reading: when the work matches a skill\'s stated trigger, read its `SKILL.md` first and follow it. If a bound skill looks relevant and you skip it, say why.',
      '- MCP and extension tools are first-class: call them instead of scripting around the same API whenever one exists.',
      '- Poll with the compact reads (`get_task_status`) and pull a full dump (`get_graph_state`) only when the whole proposal matters.',
      '- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it.',
    ].join('\n'),
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
    // The default shipped before the rule set was compacted, listed so an installation that still
    // holds it migrates instead of keeping the long version forever.
    [
      '- Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.',
      '- The two tools that steer work yourself: ask_user asks the one question whose answer changes the plan and ends the turn until the user answers - their answer arrives as recorded context in your next turn; never use it to confirm a draft, report progress or ask what you could find out. control_task acts on a task of your conversation: pause really soft-stops the running turn and only the user resumes it; abandon stops the whole task immediately and irreversibly, so record the reason and pause first while a worker lane is still writing to the target; set_budget must leave room for the context reservation when it sets a finite cap (a master node normally stays unlimited - a cap below that reservation starves the very turn that set it); steer reaches only a turn that is running right now, and when you were asked prefer resolve_problem respond.',
      '- Testing level (highest first): E2E, black box or golden file regression, then unit tests of a module or component with complete outward behaviour, and only last a fine-grained single-function unit. A "unit" is never a single function: never write one unit test per function, and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail. A tautological test that restates the production logic is forbidden, and a test that stays green while the behaviour is wrong is not a test. Hold yourself to this: renaming, splitting or restructuring internals keeps the suite green without rewriting tests.',
      '- Shared mutable state (the Pi extension install root, caches, a worktree base) changes only under a serialization lock keyed on the canonical path, and never by deleting or rebuilding a shared tree while handling one object that lives in it. A static signal - a changed file list, a declared-but-unshipped entry point - is a diagnostic only; a destructive action needs evidence from the affected object itself (npm logs, lockfiles, a real load). Tests assert invariants, never dispatch or queue order.',
    ].join('\n'),
  ],
  'runtime/worker.md': [
    'Use workspace tools to read and edit files. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.{{retrievalNote}}',
  ],
  // The role rule defaults shipped before the rule set was compacted, listed for the same reason:
  // the library rewrites a file only while it still equals a listed default, so a customised file
  // is never touched.
  'rules/worker.md': [
    [
      'Work only inside the assigned task and worktree. Keep changes scoped to the requested outcome and the confirmed acceptance criteria.',
      'Read the task graph and predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.',
      'Run the checks assigned to the node and submit structured results only when the work and evidence are complete.',
      'Prefer task-scoped changes; modify shared Graph state, credentials, or another Agent worktree only when the request explicitly requires it.',
      'Choose the highest test level that can prove the behaviour: E2E, black box or golden file regression first, then unit tests of a module or component with complete outward behaviour, and a fine-grained single-function unit only when nothing higher can prove it. Never write one unit test per function and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail - and a tautological test that restates the production logic is forbidden. A refactor of internals must keep the suite green without rewriting tests; if it forces a large rewrite, the tests were written against implementation details.',
    ].join('\n'),
  ],
  'rules/reviewer.md': [
    [
      'Review only the frozen evidence and exact versions supplied by the graph. Do not inspect the implementation transcript.',
      'Look for defects, regressions, unsupported claims, and acceptance gaps before stylistic suggestions.',
      'Show file paths, evidence, and concrete impact for every finding.',
      'Do not modify implementation files. Return an independent verdict that the verifier can evaluate.',
      'Judge the level of the tests too: E2E, black box or golden file regression first, then units of a whole module or component, and a single-function unit only when nothing higher can prove the behaviour. Flag as defects: one unit test per function, heavy dependency mocking to isolate one function, assertions on private variables, internal functions or implementation details, and tautological tests that restate the production logic. A golden file must compare only the final output, and every snapshot change must be deliberate and justified.',
    ].join('\n'),
  ],
};
const LEGACY_PROMPT_REPLACEMENTS: Partial<Record<AgentPromptKey, readonly (readonly [string, string])[]>> = {
  // The review used to ask for the whole skill inside one JSON object, which asks a model to escape
  // markdown and quietly loses the proposal. A file seeded by that version is migrated here, because
  // the library reads the visible file and a constant alone would only reach fresh installations.
  'runtime/sediment.md': [
    ['Answer with one JSON object and nothing else:', 'Answer with one line of metadata, then the skill itself:'],
    [
      '{"action":"create"|"update"|"nothing","id":"<lowercase-slug>","description":"<one sentence saying when to use it>","body":"<markdown>","reason":"<one line>"}',
      '{"action":"create"|"update"|"nothing","id":"<lowercase-slug>","description":"<one sentence saying when to use it>","reason":"<one line>"}\n'
      + 'Keep that line to metadata only — never put markdown in it. When the action is create or update, follow it with the skill in a fenced block:\n'
      + '```markdown\n<the skill: the procedure in order, the commands that work, the pitfalls>\n```',
    ],
    ['body is markdown, at most 20000 characters, and is the skill itself.', 'The fenced block is the skill itself: markdown, at most 20000 characters, the thing a future operation follows.'],
  ],
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
      worker: defaults.worker?.trim() || DEFAULT_WORKER_PROMPT,
      promptSuggestion: defaults.promptSuggestion?.trim() || DEFAULT_PROMPT_SUGGESTION_PROMPT,
      sediment: defaults.sediment?.trim() || DEFAULT_SEDIMENT_PROMPT,
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
