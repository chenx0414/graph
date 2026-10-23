package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// AgentStaticPromptKey names one editable prompt file of the Agent context library.
type AgentStaticPromptKey string

const (
	AgentPromptAgentsMain                       AgentStaticPromptKey = "agents/main.md"
	AgentPromptToolsMain                        AgentStaticPromptKey = "tools/main.md"
	AgentPromptToolsWorker                      AgentStaticPromptKey = "tools/worker.md"
	AgentPromptToolsReviewer                    AgentStaticPromptKey = "tools/reviewer.md"
	AgentPromptRulesCommon                      AgentStaticPromptKey = "rules/common.md"
	AgentPromptRulesMain                        AgentStaticPromptKey = "rules/main.md"
	AgentPromptRulesWorker                      AgentStaticPromptKey = "rules/worker.md"
	AgentPromptRulesReviewer                    AgentStaticPromptKey = "rules/reviewer.md"
	AgentPromptRuntimeWorker                    AgentStaticPromptKey = "runtime/worker.md"
	AgentPromptRuntimeNode                      AgentStaticPromptKey = "runtime/node.md"
	AgentPromptRuntimePromptSuggest             AgentStaticPromptKey = "runtime/prompt-suggestion.md"
	AgentPromptRuntimeSediment                  AgentStaticPromptKey = "runtime/sediment.md"
	AgentPromptDefaultIdentityText              string               = "You are the Main Agent in Graph. Work with the user to investigate, plan, coordinate and directly carry out scoped workspace work when needed."
	agentContextToolStateFile                   string               = "tools.json"
	agentContextUserDefaultRoot                 string               = "defaults"
	agentContextMaxPromptLength                 int                  = 250_000
	agentContextMaxToolNameLength               int                  = 240
	agentContextMaxAgentDefinitionIDLength      int                  = 160
	agentContextMaxAgentDefinitionIDPatternBody string               = `^[a-z0-9][a-z0-9._-]{0,159}$`
	agentContextPromptVariablePatternBody       string               = `\{\{([A-Za-z][A-Za-z0-9_]*)\}\}`
)

// AgentPromptKey is the key of one prompt in the library.
//
// The TypeScript narrows it to the twelve static prompt keys. Go keeps it a plain string alias
// because the console hands the key over as a request field, and a request carries no compile-time
// type. The twelve known keys are AgentStaticPromptKey, whose constants carry them.
type AgentPromptKey = string

// AgentContextDefaults overrides the built-in prompt texts of a library.
type AgentContextDefaults struct {
	Identity         *string
	CommonRules      *string
	MainRules        *string
	WorkerRules      *string
	ReviewerRules    *string
	MainTools        *string
	WorkerTools      *string
	ReviewerTools    *string
	Worker           *string
	Node             *string
	PromptSuggestion *string
	Sediment         *string
}

// AgentPromptDescriptor is one prompt of the library as the settings panel sees it.
type AgentPromptDescriptor struct {
	Key               AgentStaticPromptKey `json:"key"`
	Title             string               `json:"title"`
	Description       string               `json:"description"`
	Group             string               `json:"group"`
	Fallback          string               `json:"fallback"`
	File              string               `json:"file"`
	Content           string               `json:"content"`
	DefaultContent    string               `json:"defaultContent"`
	Customized        bool                 `json:"customized"`
	DefaultCustomized bool                 `json:"defaultCustomized"`
}

// AgentContextView is the whole library as the settings panel sees it.
type AgentContextView struct {
	Root          string                  `json:"root"`
	Prompts       []AgentPromptDescriptor `json:"prompts"`
	DisabledTools []string                `json:"disabledTools"`
}

const DEFAULT_MAIN_FULL_ACCESS_PROMPT = "Full access is active for this operation: pause, budget, usage and recovery gates do not block tool calls, and host filesystem, commands, network, MCP and extensions are available within the Agent definition. propose_system_change is auto-approved; after it returns auto_approved, call apply_system_change with that proposalId in the same turn and report the verified result."
const DEFAULT_MAIN_APPROVAL_PROMPT = "To add or update a capability, first inspect the public source and prepare an exact capability bundle, then call propose_system_change. This creates a user question and does not change anything. Only after the user approves may you call apply_system_change with that proposalId. Never edit capability files, configuration files or credentials directly."
const DEFAULT_WORKER_PROMPT = "Use the native Pi tools to read, search, edit and run commands in the assigned worktree. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Send required named graph outputs with submit; one execution permits one valid submission, and omitted outputs are disabled. Direct chat may be answered without submitting. Native bash is sandboxed by the workspace and host access policy.{{retrievalNote}}"
const DEFAULT_NODE_PROMPT = "Work within the assigned node task, acceptance criteria, workspace and bound capabilities. Use submit to send the named graph outputs when the task requires them. One execution permits one valid submit; omitted outputs are disabled. A direct chat can be answered without submit. Peer chat and interface delivery are separate channels. Read published artifacts by their exact ID and version. Code and review references must identify the exact commit. Respect the recipe rules and host permissions; a review task does not grant permission to implement changes."
const DEFAULT_PROMPT_SUGGESTION_PROMPT = "Write exactly one concise next message the user may want to send. Use the same language as the user message. Return only that message. Do not explain, quote, label, or mention suggestions or the composer. If there is no useful next message, return an empty string."
const DEFAULT_SEDIMENT_PROMPT = "You are reviewing one finished operation of a coding agent, deciding whether it taught something worth keeping as a skill.\nAnswer with one line of metadata, then the skill itself:\n{\"action\":\"create\"|\"update\"|\"nothing\",\"id\":\"<lowercase-slug>\",\"description\":\"<one sentence saying when to use it>\",\"reason\":\"<one line>\"}\nKeep that line to metadata only — never put markdown in it. When the action is create or update, follow it with the skill in a fenced block:\n```markdown\n<the skill: the procedure in order, the commands that work, the pitfalls>\n```\nUse \"nothing\" when the operation taught nothing reusable. That is a real answer, but not the default: an operation that involved a correction, a dead end, or a non-trivial technique usually taught something.\n\nWhat a skill is: the instructions for doing a class of task the efficient and correct way — the procedure in order, the commands that work, and the pitfalls that cost time.\nA pitfall is a generalizable rule plus one clause of why. Never write PR or issue numbers, dates, or quoted conversation as content: the rule has to stand without the story behind it.\nThe same lesson learned twice is ONE rule. If an existing skill already states it, propose \"update\" for that id and fold it in instead of adding a second copy.\nDo not restate what the environment already teaches every turn (the repository AGENTS.md, tool schemas).\nFix a skill in place when it is wrong: edit the sentence that misled, do not append \"UPDATE: actually…\" underneath it.\n\nSignals that warrant a skill (any one of them):\n- the user corrected the approach, the order of steps, or the shape of the result;\n- a non-trivial technique, workaround, or debugging path emerged that a future operation would benefit from;\n- a skill read during this operation turned out to be wrong, incomplete, or outdated.\n\nNever capture (these harden into constraints the agent later cites against itself):\n- environment failures: a missing binary, an uninstalled package, an unconfigured credential, a command that was not found;\n- negative claims about a tool or a feature (\"X does not work\");\n- transient errors that a retry fixed — the lesson is the retry, not the failure;\n- one-off task narratives;\n- attempts that never worked. If the operation ended without finding a working method, answer \"nothing\" instead of presenting dead ends as guidance.\n\nField rules: id is a lowercase slug, at most 60 characters, and names the CLASS of task rather than today's incident (never a PR number, a file name, or \"fix-X-today\").\ndescription is one sentence, at most 300 characters, and must say when to use the skill (\"Use when …\").\nThe fenced block is the skill itself: markdown, at most 20000 characters, the thing a future operation follows."
const DEFAULT_COMMON_RULES = "- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed.\n- You can inspect PI_* environment variables for current model and session details.\n- Use edit for precise changes (edits[].oldText must match exactly)\n- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls\n- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.\n- Use write only for new files or complete rewrites.\n- Be concise in your responses\n- Show file paths clearly when working with files\n- Use tool results as evidence.\n- R22 Test order: prove regressions through a real E2E flow before the fix and verify the same flow after it.\n- R23 Test means: only author E2E tests; never write unit or integration tests. Keep repeatable execution evidence.\n- R24 Test boundary: exercise the complete application flow with real owned components; substitute only external services.\n- R27 Test level (high level first): E2E is the only permitted level for newly authored or modified tests. Black-box and golden-file checks qualify only through a complete E2E flow. Run existing tests, preserve independent contracts and report E2E environment blockers instead of adding isolated tests.\n- Search the repository with the indexed extension tools (ffind, ffgrep) instead of shell find/grep: they are git-aware and ranked by how often files are actually accessed. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.\n- MCP servers and extension tools are first-class: when one exists, call it instead of scripting around the same API.\n- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it."
const DEFAULT_MAIN_RULES = "- R14 When one node stays blocked for three rounds, stop the loop and take the work over yourself: fix the product defect, fix the harness root cause, pass the full host gate, merge into the application main line, push, deploy (RSI activate), verify live, then hand it to the user for acceptance."
const DEFAULT_WORKER_RULES = "Work only inside the assigned task and worktree. Keep the change scoped to the requested outcome and the confirmed acceptance criteria.\nRead the task graph and the predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.\nRun the checks assigned to that node, and submit structured results only when the work and its evidence are complete.\nStay inside the file list of your node, and only that list. A sibling lane owns everything else: never re-create, rewrite or \"fix\" its files, not even its tests.\nChoose an E2E command compatible with the actual host sandbox. When browser, socket or process access is unavailable, report the constraint and have main run the real E2E flow in a suitable environment; never substitute a pure-logic unit or integration test.\nIf your work copy already contains files you do not own - a sibling lane's - restore them to the integration tip (`git checkout <integration sha> -- <paths>`) before committing. Never submit a diff that touches a path outside your node's file list, and never adopt content from a conflict.\nDo not modify shared Graph state, credentials, or another Agent's worktree."
const DEFAULT_REVIEWER_RULES = "Review only the frozen evidence and the exact versions the graph supplies. Do not inspect the implementation transcript.\nLook for defects, regressions, unsupported claims and acceptance gaps before stylistic suggestions.\nShow file paths, evidence and concrete impact for every finding.\nDo not modify implementation files. Return an independent verdict the verifier can evaluate.\nEvery judgment you report carries `files`: the repository-relative paths a fix would have to touch for that finding. Name real files (no absolute paths, no directories as a guess); when a finding needs a file no lane owns, say so in the reason as well.\nHold the change to the shared testing standard in `rules/common.md`, and treat a breach of it as a real defect rather than a style note."
const DEFAULT_MAIN_TOOL_GUIDANCE = "- Skills are on-demand instructions, not background reading: when the work matches a skill's stated trigger, read its `SKILL.md` first and follow it. If a bound skill looks relevant and you skip it, say why.\n- Poll with the compact reads (`get_task_status`) and pull a full dump (`get_graph_state`) only when the whole proposal matters."
const DEFAULT_WORKER_TOOL_GUIDANCE = "Use the smallest set of workspace and capability tools needed for the assigned node. Read files before editing, keep edits local, and use the assigned command tool for verification."
const DEFAULT_REVIEWER_TOOL_GUIDANCE = "Use read-only evidence, artifact and inspection tools. Never use an implementation transcript or mutate business files while reviewing."
const DEFAULT_MAIN_FULL_ACCESS_IDENTITY = "Full access is active for this operation. Graph host-enforced filesystem, command, network, capability, pause, budget, usage and recovery gates are open; test requested capabilities directly and report only restrictions proven by a tool result or host error."
const DEFAULT_MAIN_RSI_IDENTITY = "You are also the maintainer of this Graph harness: the executor and the improver are the same Agent. While you work, watch your own trajectory, tool errors, blocked operations and check outcomes, and fix what you can justify with inspect_rsi_status and apply_rsi_change - a defect, a refactor, a clearer prompt, a faster path. Read that evidence instead of recalling it: read_harness_evidence reports the tool calls that failed, the work that got blocked, how the last applied change checked out and what the run cost, and probe_harness runs one task under several harnesses so you can see which harness actually helps. When a probe shows which harness won, keep the lesson with record_harness_decision - a lesson on the general axis reaches every later task of the project, a domain lesson stays with its domain - and compare candidates with compare_harness_candidates, which reports the facts and never the verdict. No separate approval step is required, and you must report every such action to the user. Keep a harness backlog outside your context instead of in your memory: the moment you notice friction - a defect, a blocked or misleading tool, an unclear prompt, a slow or wasteful path, an error the user had to point out - record it in the published `plans` artifact `harness-backlog`, one line per item with its status (open, fixed@<commit>, rejected) and the evidence that shows it, even when you are not fixing it now. Publish a new version whenever you add or close an item and promote it to project scope so later tasks in this project find it; a compacted or restarted context must never be the only place the backlog lives. When you finish a work item, or hand it to the user for acceptance, report that backlog unprompted: what you fixed, what is still open, and which items you propose to take next with their expected cost and risk. The user must never have to ask you for RSI. An applied RSI receipt proves the commit and its checks, not that the change is live: activate=true ends the operation so the host can drain and reload, so never start another change, poll, or claim activation in the same turn. Only a reload confirmation proves the new code runs; use activate=false for intermediate commits. Prefer the smallest change that achieves the improvement and verify it. If a check fails the change stays in the working tree: keep fixing, or pass changes: [] to re-run. Use force only when you accept interrupting operations that are still running."
const CLASSIFIED_MAIN_RSI_IDENTITY = "You are also the maintainer of this Graph harness: the executor and the improver are the same Agent. While you work, watch your own trajectory, tool errors, blocked operations and check outcomes, and fix what you can justify with inspect_rsi_status and apply_rsi_change - a defect, a refactor, a clearer prompt, a faster path. Read that evidence instead of recalling it: read_harness_evidence reports the tool calls that failed, the work that got blocked, how the last applied change checked out and what the run cost, and probe_harness runs one task under several harnesses so you can see which harness actually helps. When a probe shows which harness won, keep the lesson with record_harness_decision - a lesson on the general axis reaches every later task of the project, a domain lesson stays with its domain - and compare candidates with compare_harness_candidates, which reports the facts and never the verdict. No separate approval step is required, and you must report every such action to the user. Keep a harness backlog outside your context instead of in your memory: when evidence identifies friction in Graph itself - a harness defect, a blocked or misleading Graph tool, an unclear harness prompt, a slow harness path - record it in the published `plans` artifact `harness-backlog`, one line per item with its status (open, fixed@<commit>, rejected) and the evidence that shows it, even when you are not fixing it now. Publish a new version whenever you add or close an item and promote it to project scope so later tasks in this project find it; a compacted or restarted context must never be the only place the backlog lives. When you finish a work item, or hand it to the user for acceptance, report that backlog unprompted: what you fixed, what is still open, and which items you propose to take next with their expected cost and risk. The user must never have to ask you for RSI. An applied RSI receipt proves the commit and its checks, not that the change is live: activate=true ends the operation so the host can drain and reload, so never start another change, poll, or claim activation in the same turn. Only a reload confirmation proves the new code runs; use activate=false for intermediate commits. Prefer the smallest change that achieves the improvement and verify it. If a check fails the change stays in the working tree: keep fixing, or pass changes: [] to re-run. Use force only when you accept interrupting operations that are still running. A failing project check, missing project configuration, or a business-code defect is evidence about the requested project work. It becomes a harness backlog item only when the observed result also demonstrates a defect in Graph instructions, tools, or execution. Continue correcting project failures through the requested work and its acceptance checks."

// agentStaticPrompt is the fixed metadata of one prompt file.
type agentStaticPrompt struct {
	Key         AgentStaticPromptKey
	Title       string
	Description string
	Group       string
	Fallback    string
}

var agentStaticPrompts = []agentStaticPrompt{
	{Key: "agents/main.md", Title: "Main Agent 身份", Description: "作为 system prompt 注入的身份与职责。", Group: "identity", Fallback: "identity"},
	{Key: "tools/main.md", Title: "Main 工具指导", Description: "Main Agent 的人类可编辑工具使用规则。", Group: "tools", Fallback: "mainTools"},
	{Key: "tools/worker.md", Title: "Worker 工具指导", Description: "实现 Agent 的工具使用规则。", Group: "tools", Fallback: "workerTools"},
	{Key: "tools/reviewer.md", Title: "Reviewer 工具指导", Description: "审查 Agent 的只读工具使用规则。", Group: "tools", Fallback: "reviewerTools"},
	{Key: "rules/common.md", Title: "通用规则", Description: "所有 Agent 共享的简洁证据规则。", Group: "rules", Fallback: "commonRules"},
	{Key: "rules/main.md", Title: "Main Agent 规则", Description: "Main Agent 的智能体方案命名规则。", Group: "rules", Fallback: "mainRules"},
	{Key: "rules/worker.md", Title: "Worker 规则", Description: "实现 Agent 的任务范围与工作副本规则。", Group: "rules", Fallback: "workerRules"},
	{Key: "rules/reviewer.md", Title: "Reviewer 规则", Description: "独立审查的证据隔离和只读规则。", Group: "rules", Fallback: "reviewerRules"},
	{Key: "runtime/worker.md", Title: "Worker 运行规则", Description: "普通实现、审查和验证 Agent 每次 operation 注入 system prompt 的 runtime rules。", Group: "runtime", Fallback: "worker"},
	{Key: "runtime/node.md", Title: "Graph 节点运行规则", Description: "接口投递内核中实现和审查节点使用的运行规则；任务和输出要求由节点声明。", Group: "runtime", Fallback: "node"},
	{Key: "runtime/prompt-suggestion.md", Title: "输入建议生成", Description: "仅主 Agent 回复后生成下一条输入建议的独立模型请求使用。", Group: "runtime", Fallback: "promptSuggestion"},
	{Key: "runtime/sediment.md", Title: "技能沉淀自省", Description: "仅在开关开启时，操作收尾后为沉淀技能而发起的独立模型请求使用。", Group: "runtime", Fallback: "sediment"},
}

// resolvedAgentContextDefaults holds the effective text of every prompt slot.
type resolvedAgentContextDefaults struct {
	Identity         string
	CommonRules      string
	MainRules        string
	WorkerRules      string
	ReviewerRules    string
	MainTools        string
	WorkerTools      string
	ReviewerTools    string
	Worker           string
	Node             string
	PromptSuggestion string
	Sediment         string
}

// agentToolStateFile is the on-disk shape of tools.json.
type agentToolStateFile struct {
	Version  int      `json:"version"`
	Disabled []string `json:"disabled"`
}

var agentContextPromptVariablePattern = regexp.MustCompile(agentContextPromptVariablePatternBody)
var agentContextDefinitionIDPattern = regexp.MustCompile(agentContextMaxAgentDefinitionIDPatternBody)

// agentContextTrimEnd trims trailing whitespace the way String.prototype.trimEnd does.
func agentContextTrimEnd(value string) string {
	return strings.TrimRightFunc(value, agentContextIsSpace)
}

// agentContextIsSpace reports the runes JavaScript treats as whitespace.
func agentContextIsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0x00A0, 0x1680, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
		return true
	}
	return r >= 0x2000 && r <= 0x200A
}

// agentContextWriteAtomic writes a file through a pending sibling, the way the
// TypeScript library did, so a reader never sees a half-written prompt.
func agentContextWriteAtomic(path, content string) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		panic(err)
	}
	pending := path + "." + itoa(os.Getpid()) + ".pending"
	if err := os.WriteFile(pending, []byte(content), 0o600); err != nil {
		panic(err)
	}
	if err := os.Rename(pending, path); err != nil {
		panic(err)
	}
}

// agentContextWriteNew creates a file once. An existing file is left untouched.
func agentContextWriteNew(path, content string) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		if os.IsExist(err) {
			return
		}
		panic(err)
	}
	defer file.Close()
	if _, err := file.WriteString(content); err != nil {
		panic(err)
	}
}

// agentContextReadOptional reads a file. A missing file is not an error.
func agentContextReadOptional(path string) (string, bool, error) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return "", false, nil
		}
		return "", false, err
	}
	return string(body), true, nil
}

// agentContextReadRequired reads a file and fails when it is missing.
func agentContextReadRequired(path string) string {
	body, ok, err := agentContextReadOptional(path)
	if err != nil {
		panic(err)
	}
	if !ok {
		panic(os.ErrNotExist)
	}
	return body
}

// agentLegacyPromptPaths are the pre-rename files a prompt may still live in.
var agentLegacyPromptPaths = map[AgentPromptKey]string{
	"tools/main.md": "tool-awareness.md",
}

// render substitutes the {{variable}} placeholders of a prompt.
func render(content string, variables map[string]string) string {
	return agentContextPromptVariablePattern.ReplaceAllStringFunc(content, func(match string) string {
		name := agentContextPromptVariablePattern.FindStringSubmatch(match)[1]
		return variables[name]
	})
}

// RenderAgentPrompt substitutes the {{variable}} placeholders of a prompt.
func RenderAgentPrompt(content string, variables map[string]string) string {
	return render(content, variables)
}

// agentContextPath joins a prompt key onto the library root.
func agentContextPath(root, key string) string {
	return filepath.Join(root, filepath.FromSlash(key))
}

// agentPath is the identity file of one published Agent definition.
func agentPath(root, definitionID string) string {
	if !agentContextDefinitionIDPattern.MatchString(definitionID) {
		Raise("invalid_input", "Invalid Agent definition id "+definitionID)
	}
	return filepath.Join(root, "agents", definitionID+".md")
}

// AgentContextLibrary is the editable prompt library of one Graph installation.
type AgentContextLibrary struct {
	Root        string
	ContextRoot string
	defaults    resolvedAgentContextDefaults
	// overlay replaces the text of the named prompts. It is how one node runs
	// under a different harness than the rest: the replacement has to live in
	// the library the session reads, not beside it.
	overlay map[string]string
}

// WithOverlay returns a library that replaces the named prompts with the given
// texts. The base library is untouched.
func (library *AgentContextLibrary) WithOverlay(overlay map[string]string) *AgentContextLibrary {
	if library == nil || len(overlay) == 0 {
		return library
	}
	copied := *library
	copied.overlay = make(map[string]string, len(overlay))
	for key, text := range overlay {
		copied.overlay[key] = text
	}
	return &copied
}

// NewAgentContextLibrary opens a prompt library with optional built-in overrides.
func NewAgentContextLibrary(root string, defaults AgentContextDefaults) *AgentContextLibrary {
	library := &AgentContextLibrary{Root: root, ContextRoot: root}
	library.defaults = resolvedAgentContextDefaults{
		Identity:         agentContextDefault(defaults.Identity, AgentPromptDefaultIdentityText),
		CommonRules:      agentContextDefault(defaults.CommonRules, DEFAULT_COMMON_RULES),
		MainRules:        agentContextDefault(defaults.MainRules, DEFAULT_MAIN_RULES),
		WorkerRules:      agentContextDefault(defaults.WorkerRules, DEFAULT_WORKER_RULES),
		ReviewerRules:    agentContextDefault(defaults.ReviewerRules, DEFAULT_REVIEWER_RULES),
		MainTools:        agentContextDefault(defaults.MainTools, DEFAULT_MAIN_TOOL_GUIDANCE),
		WorkerTools:      agentContextDefault(defaults.WorkerTools, DEFAULT_WORKER_TOOL_GUIDANCE),
		ReviewerTools:    agentContextDefault(defaults.ReviewerTools, DEFAULT_REVIEWER_TOOL_GUIDANCE),
		Worker:           agentContextDefault(defaults.Worker, DEFAULT_WORKER_PROMPT),
		Node:             agentContextDefault(defaults.Node, DEFAULT_NODE_PROMPT),
		PromptSuggestion: agentContextDefault(defaults.PromptSuggestion, DEFAULT_PROMPT_SUGGESTION_PROMPT),
		Sediment:         agentContextDefault(defaults.Sediment, DEFAULT_SEDIMENT_PROMPT),
	}
	return library
}

// OpenAgentContextLibrary opens the prompt library of one state directory.
func OpenAgentContextLibrary(root string, defaults ...AgentContextDefaults) *AgentContextLibrary {
	selected := AgentContextDefaults{}
	if len(defaults) > 0 {
		selected = defaults[0]
	}
	return NewAgentContextLibrary(root, selected)
}

// agentContextDefault keeps a trimmed override, or the built-in text.
func agentContextDefault(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	trimmed := strings.TrimSpace(*value)
	if trimmed == "" {
		return fallback
	}
	return trimmed
}

// descriptor returns the fixed metadata of one prompt key.
func (library *AgentContextLibrary) descriptor(key AgentPromptKey) agentStaticPrompt {
	for _, prompt := range agentStaticPrompts {
		if string(prompt.Key) == key {
			return prompt
		}
	}
	Raise("invalid_input", "Unknown Agent prompt "+key)
	return agentStaticPrompt{}
}

// promptPath is the file one prompt key owns.
func (library *AgentContextLibrary) promptPath(key AgentPromptKey) string {
	library.descriptor(key)
	return agentContextPath(library.Root, key)
}

// userDefaultPath is the file that holds the user-owned reset default.
func (library *AgentContextLibrary) userDefaultPath(key AgentPromptKey) string {
	library.descriptor(key)
	return agentContextPath(library.Root, agentContextUserDefaultRoot+"/"+key)
}

// builtInContent is the shipped text of one prompt.
func (library *AgentContextLibrary) builtInContent(key AgentPromptKey) string {
	return library.fallbackContent(library.descriptor(key).Fallback)
}

// fallbackContent is the shipped text of one defaults slot.
func (library *AgentContextLibrary) fallbackContent(name string) string {
	switch name {
	case "identity":
		return library.defaults.Identity
	case "commonRules":
		return library.defaults.CommonRules
	case "mainRules":
		return library.defaults.MainRules
	case "workerRules":
		return library.defaults.WorkerRules
	case "reviewerRules":
		return library.defaults.ReviewerRules
	case "mainTools":
		return library.defaults.MainTools
	case "workerTools":
		return library.defaults.WorkerTools
	case "reviewerTools":
		return library.defaults.ReviewerTools
	case "worker":
		return library.defaults.Worker
	case "node":
		return library.defaults.Node
	case "promptSuggestion":
		return library.defaults.PromptSuggestion
	case "sediment":
		return library.defaults.Sediment
	}
	return ""
}

// descriptors lists every prompt of the library.
func (library *AgentContextLibrary) descriptors() []AgentPromptDescriptor {
	out := make([]AgentPromptDescriptor, 0, len(agentStaticPrompts))
	for _, prompt := range agentStaticPrompts {
		content := library.fallbackContent(prompt.Fallback)
		out = append(out, AgentPromptDescriptor{
			Key:               prompt.Key,
			Title:             prompt.Title,
			Description:       prompt.Description,
			Group:             prompt.Group,
			Fallback:          prompt.Fallback,
			File:              library.promptPath(string(prompt.Key)),
			Content:           content,
			DefaultContent:    content,
			Customized:        false,
			DefaultCustomized: false,
		})
	}
	return out
}

// userDefault reads the user-owned reset default of one prompt.
func (library *AgentContextLibrary) userDefault(key AgentPromptKey) (string, bool, error) {
	return agentContextReadOptional(library.userDefaultPath(key))
}

// effectiveDefault is the text a reset restores: the user default, else the built-in.
func (library *AgentContextLibrary) effectiveDefault(key AgentPromptKey) (string, error) {
	value, ok, err := library.userDefault(key)
	if err != nil {
		return "", err
	}
	if ok {
		return value, nil
	}
	return library.builtInContent(key), nil
}

// Ensure seeds the library on first launch. It never overwrites an existing file.
func (library *AgentContextLibrary) Ensure() {
	if err := os.MkdirAll(library.Root, 0o700); err != nil {
		panic(err)
	}
	readme := strings.Join([]string{
		"# Graph Agent Context Library",
		"",
		"These files are read before the next Agent operation and can be edited here or in Graph.",
		"Graph seeds the defaults on first launch and never overwrites an existing file.",
		"Use Reset in the Agent Context panel to restore the original built-in version.",
		"",
		"identity: agents/",
		"tool guidance: tools/",
		"rules: rules/",
		"runtime-only prompts: runtime/",
		"user-defined reset defaults: defaults/ (may be empty)",
		"read-only Agent docs: <application>/docs/agent/",
	}, "\n")
	agentContextWriteNew(filepath.Join(library.Root, "README.md"), readme+"\n")
	for _, descriptor := range library.descriptors() {
		key := string(descriptor.Key)
		if err := os.MkdirAll(filepath.Dir(descriptor.File), 0o700); err != nil {
			panic(err)
		}
		userDefault, hasUserDefault, err := library.userDefault(key)
		if err != nil {
			panic(err)
		}
		legacyPath, hasLegacy := agentLegacyPromptPaths[key]
		legacy := ""
		if hasLegacy {
			value, ok, err := agentContextReadOptional(agentContextPath(library.Root, legacyPath))
			if err != nil {
				panic(err)
			}
			if ok {
				legacy = value
			}
		}
		seed := descriptor.Content
		if hasUserDefault {
			seed = userDefault
		} else if strings.TrimSpace(legacy) != "" {
			seed = legacy
		}
		agentContextWriteNew(descriptor.File, agentContextTrimEnd(seed)+"\n")
		if hasUserDefault {
			continue
		}
		current, ok, err := agentContextReadOptional(descriptor.File)
		if err != nil {
			panic(err)
		}
		if !ok {
			continue
		}
		migrated := current
		for _, value := range agentLegacyPromptDefaults[key] {
			if agentContextTrimEnd(current) == agentContextTrimEnd(value) {
				migrated = agentContextTrimEnd(descriptor.Content) + "\n"
				break
			}
		}
		for _, pair := range agentLegacyPromptReplacements[key] {
			migrated = strings.Replace(migrated, pair[0], pair[1], 1)
		}
		if migrated != current {
			agentContextWriteAtomic(descriptor.File, migrated)
		}
	}
}

// Prompt renders the effective text of one prompt. An unknown key is refused
// with the error the TypeScript library rejected its promise with.
func (library *AgentContextLibrary) Prompt(key AgentPromptKey, variables ...map[string]string) (result string, err error) {
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		failure, ok := recovered.(*RuntimeError)
		if !ok {
			panic(recovered)
		}
		result, err = "", failure
	}()
	values := map[string]string{}
	if len(variables) > 0 && variables[0] != nil {
		values = variables[0]
	}
	if library.overlay != nil {
		if text, ok := library.overlay[string(key)]; ok && strings.TrimSpace(text) != "" {
			return agentContextTrimEnd(render(text, values)), nil
		}
	}
	custom, hasCustom, err := library.Override(key)
	if err != nil {
		return "", err
	}
	fallback, err := library.effectiveDefault(key)
	if err != nil {
		return "", err
	}
	if hasCustom {
		return agentContextTrimEnd(render(custom, values)), nil
	}
	return agentContextTrimEnd(render(fallback, values)), nil
}

// AgentPrompt is the identity override of one published Agent definition.
func (library *AgentContextLibrary) AgentPrompt(definitionID string, fallback *string) string {
	ids := []string{definitionID}
	if definitionID == "master" {
		ids = []string{"main", "master"}
	}
	for _, id := range ids {
		if library.overlay != nil {
			if text, ok := library.overlay["agents/"+id+".md"]; ok && strings.TrimSpace(text) != "" {
				return agentContextTrimEnd(text)
			}
		}
		custom, ok, err := agentContextReadOptional(agentPath(library.Root, id))
		if err != nil {
			panic(err)
		}
		if ok {
			return agentContextTrimEnd(custom)
		}
	}
	if definitionID == "main" || definitionID == "master" {
		if fallback != nil {
			if trimmed := strings.TrimSpace(*fallback); trimmed != "" {
				return trimmed
			}
		}
		return library.defaults.Identity
	}
	if fallback != nil {
		return strings.TrimSpace(*fallback)
	}
	return ""
}

// Override is the user-edited text of one prompt, if there is one.
func (library *AgentContextLibrary) Override(key AgentPromptKey) (string, bool, error) {
	current, ok, err := agentContextReadOptional(library.promptPath(key))
	if err != nil {
		return "", false, err
	}
	if ok {
		return current, true, nil
	}
	legacyPath, hasLegacy := agentLegacyPromptPaths[key]
	if !hasLegacy {
		return "", false, nil
	}
	value, ok, err := agentContextReadOptional(agentContextPath(library.Root, legacyPath))
	if err != nil {
		return "", false, err
	}
	return value, ok, nil
}

// SavePrompt writes the user-edited text of one prompt.
func (library *AgentContextLibrary) SavePrompt(key AgentPromptKey, content string) {
	if len(content) > agentContextMaxPromptLength {
		Raise("invalid_input", "Prompt content must be at most 250000 characters")
	}
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(content)+"\n")
}

// SetPromptDefault writes the user-owned reset default and the prompt itself.
func (library *AgentContextLibrary) SetPromptDefault(key AgentPromptKey, content string) {
	if len(content) > agentContextMaxPromptLength {
		Raise("invalid_input", "Prompt content must be at most 250000 characters")
	}
	normalized := agentContextTrimEnd(content) + "\n"
	agentContextWriteAtomic(library.userDefaultPath(key), normalized)
	agentContextWriteAtomic(library.promptPath(key), normalized)
}

// ClearPromptDefault drops the user-owned reset default and restores the built-in.
func (library *AgentContextLibrary) ClearPromptDefault(key AgentPromptKey) {
	if err := os.Remove(library.userDefaultPath(key)); err != nil && !os.IsNotExist(err) {
		panic(err)
	}
	builtIn := library.builtInContent(key)
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(builtIn)+"\n")
}

// ResetPrompt restores the effective default of one prompt.
func (library *AgentContextLibrary) ResetPrompt(key AgentPromptKey) {
	fallback, err := library.effectiveDefault(key)
	if err != nil {
		panic(err)
	}
	agentContextWriteAtomic(library.promptPath(key), agentContextTrimEnd(fallback)+"\n")
}

// DisabledTools lists the tool names the user turned off.
func (library *AgentContextLibrary) DisabledTools() []string {
	path := filepath.Join(library.Root, agentContextToolStateFile)
	body, ok, err := agentContextReadOptional(path)
	if err != nil {
		panic(err)
	}
	if !ok {
		return append([]string{}, agentContextDefaultDisabledTools...)
	}
	var state any
	if err := json.Unmarshal([]byte(body), &state); err != nil {
		panic(err)
	}
	record := asMap(state)
	if record == nil {
		Raise("invalid_config", path+" must contain a disabled string array")
	}
	raw, _ := record["disabled"].([]any)
	if raw == nil {
		Raise("invalid_config", path+" must contain a disabled string array")
	}
	names := []string{}
	for _, item := range raw {
		name, isString := item.(string)
		if !isString || strings.TrimSpace(name) == "" {
			Raise("invalid_config", path+" must contain a disabled string array")
		}
		names = append(names, strings.TrimSpace(name))
	}
	return agentContextUniqueSorted(names)
}

// SetDisabledTools turns tools off and reports the stored names.
func (library *AgentContextLibrary) SetDisabledTools(values []string) []string {
	candidates := []string{}
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			candidates = append(candidates, trimmed)
		}
	}
	disabled := agentContextUniqueSorted(candidates)
	for _, name := range disabled {
		if len(name) > agentContextMaxToolNameLength || strings.ContainsAny(name, "\x00\r\n") {
			Raise("invalid_input", "Invalid tool name "+name)
		}
	}
	body, err := json.MarshalIndent(agentToolStateFile{Version: 1, Disabled: disabled}, "", "  ")
	if err != nil {
		panic(err)
	}
	agentContextWriteAtomic(filepath.Join(library.Root, agentContextToolStateFile), string(body)+"\n")
	return disabled
}

// View is the whole library as the settings panel sees it.
func (library *AgentContextLibrary) View(variables map[string]string) AgentContextView {
	prompts := []AgentPromptDescriptor{}
	for _, descriptor := range library.descriptors() {
		key := string(descriptor.Key)
		custom, hasCustom, err := library.Override(key)
		if err != nil {
			panic(err)
		}
		userDefault, hasUserDefault, err := library.userDefault(key)
		if err != nil {
			panic(err)
		}
		builtIn := library.builtInContent(key)
		effectiveDefault := builtIn
		if hasUserDefault {
			effectiveDefault = userDefault
		}
		current := effectiveDefault
		if hasCustom {
			current = custom
		}
		defaultCustomized := hasUserDefault &&
			agentContextTrimEnd(userDefault) != agentContextTrimEnd(builtIn)
		prompts = append(prompts, AgentPromptDescriptor{
			Key:               descriptor.Key,
			Title:             descriptor.Title,
			Description:       descriptor.Description,
			Group:             descriptor.Group,
			Fallback:          descriptor.Fallback,
			File:              descriptor.File,
			Content:           agentContextTrimEnd(render(current, variables)),
			DefaultContent:    agentContextTrimEnd(render(effectiveDefault, variables)),
			Customized:        agentContextTrimEnd(current) != agentContextTrimEnd(effectiveDefault),
			DefaultCustomized: defaultCustomized,
		})
	}
	return AgentContextView{Root: library.Root, Prompts: prompts, DisabledTools: library.DisabledTools()}
}

var agentLegacyPromptDefaults = map[AgentPromptKey][]string{
	"tools/main.md": {
		"# Capability awareness\n\nThe capability bundle is scoped to this Agent instance and the exact definition version in the briefing.\n\nUse Skills as on-demand instructions: read the declared `SKILL.md` before applying one. Use MCP and extension tools through their declared names. Resolve file references inside the assigned workspace unless the tool explicitly says otherwise.\n\nEvery model, command, MCP, and extension call is governed by Graph. If a call is blocked by pause, budget, permission, or recovery rules, stop and report the blocking reason instead of inventing another route.",
		"Use only the callable tools listed below. Pi native tools are the basic workspace surface; use them directly when the task requires investigation or changes. Graph enforces every model, command, MCP and extension call at the host boundary.",
		"## Reaching for the right capability\n\n- Search inside the repository with the indexed extensions (`ffind`, `ffgrep`) instead of shell `find`/`grep`: they are git-aware and ranked by access frequency. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.\n- Skills are on-demand instructions, not background reading: when the work matches a skill's stated trigger, read its `SKILL.md` first and follow it. If a bound skill looks relevant and you skip it, say why.\n- MCP and extension tools are first-class: call them instead of scripting around the same API whenever one exists.\n- Poll with the compact reads (`get_task_status`) and pull a full dump (`get_graph_state`) only when the whole proposal matters.\n- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it.",
	},
	"agents/main.md": {
		"# Master Agent identity\n\nYou are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.\n\nKeep your identity stable across models. Use the native Pi tools to investigate and make workspace changes when the user's request requires them, while keeping changes scoped to the request and confirmed graph. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.\n\nWhen a task delivers or changes anything visible in the console (a page, a control, a message row), verify it yourself before asking the user to accept it: open the page with `agent_browser`, assert the elements and the copy you expect (icon instead of text, `data-testid`, `aria-label`, visible wording), exercise the interaction and read the result back out of the DOM, and attach a screenshot as evidence. Then ask the user only for the judgement a human must make. `graph.command` check nodes cannot do this - their sandbox has no window services, so a real browser never runs there - which makes this the master's own step, and it never replaces a bound acceptance check.",
		"# Master Agent identity\n\nYou are the Master Agent for one Graph feature task. You talk directly with the user, investigate the project, expose uncertainty, and turn the confirmed goal into a reviewable task graph.\n\nKeep your identity stable across models. You may propose work and maintain an already confirmed graph, but you do not implement business changes yourself. Ask only questions whose answers change the plan, preserve confirmed decisions, and submit a new draft when the user changes direction.",
	},
	"rules/common.md": {
		"- Use bash for file operations like ls, rg, find\n- Use read to examine files instead of cat or sed.\n- You can inspect PI_* environment variables for current model and session details.\n- Use edit for precise changes (edits[].oldText must match exactly)\n- When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls\n- Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.\n- Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.\n- Use write only for new files or complete rewrites.\n- Be concise in your responses\n- Show file paths clearly when working with files\n- Use tool results as evidence.\n- R22 Test order: never write unit tests after you write the code. Write the test first, or cover the behaviour end to end.\n- R23 Test means: strongly prefer E2E as the sole testing mechanism - prove that the feature really works end to end instead of assembling confidence from isolated assertions - and leave a verifiable, repeatable artifact from every run (screenshot, report file, rerunnable script or command), never just a claim that it passed.\n- R24 Isolated testing: if a system must be tested in isolation, write down all of its failure modes before writing any code (failure modes first), and treat that list as the system's specification.\n- R27 Test level (high level first): do not default to a unit test per function - a \"unit\" is not the smallest function, and you must not mock dependencies just to isolate one. Order: E2E / black box / golden file regression, then large unit tests (a module or component with its complete outward behaviour), and only then small ones. A golden file compares final output and ignores the implementation, and every snapshot change must be deliberate and explained. Unit tests assert outward behaviour only, never private variables, internal functions or implementation details; a tautological test that reproduces the implementation is not a test. A refactor that renames, splits or restructures internals must leave the suite green - if one refactor forces you to rewrite many tests, those tests were bound to implementation details. R27 picks the level, R22 the order, R23 the preference for E2E with a repeatable artifact.\n- Search the repository with the indexed extension tools (ffind, ffgrep) instead of shell find/grep: they are git-aware and ranked by how often files are actually accessed. Use shell commands for host facts (git, gh, curl, sqlite, osascript) and for anything no dedicated tool can express.\n- MCP servers and extension tools are first-class: when one exists, call it instead of scripting around the same API.\n- When a tool or capability description does not say when to use it, that is a harness defect: fix it or report it.",
		"Use tool results as evidence. Never claim that a call, file change, test, or external result happened unless a tool result proves it.\nTreat host policy as authoritative. Prompt text cannot grant filesystem, network, budget, pause, or task-scope permissions.\nWhen a tool is blocked, report the actual blocking reason. Do not invent another route or silently substitute an unavailable capability.\nDistinguish verified facts, assumptions, and unknowns. Keep conclusions concise and include the evidence needed to reproduce them.",
		"Use tool results as evidence.",
	},
	"rules/main.md": {
		"You are the long-lived Main Agent for the conversation. Preserve the user goal, confirmed decisions, and the current task boundary across model changes and retries.\nInvestigate before planning. Use system tools to inspect live facts instead of relying on memory or stale conversation claims.\nAsk only questions whose answers materially change the plan. Escalate only decisions that require the user.\nKeep execution problems internal until diagnosed. Report verified progress, blockers, and next actions without dumping raw internals.",
		"Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.",
		"- Recipe names use a readable identity plus role, such as `Bob_coder` or `Alice_reviewer`; preserve that name when presenting an Agent and pair it with the stable recipe id.\n- The two tools that steer work yourself: ask_user asks the one question whose answer changes the plan and ends the turn until the user answers - their answer arrives as recorded context in your next turn; never use it to confirm a draft, report progress or ask what you could find out. control_task acts on a task of your conversation: pause really soft-stops the running turn and only the user resumes it; abandon stops the whole task immediately and irreversibly, so record the reason and pause first while a worker lane is still writing to the target; set_budget must leave room for the context reservation when it sets a finite cap (a master node normally stays unlimited - a cap below that reservation starves the very turn that set it); steer reaches only a turn that is running right now, and when you were asked prefer resolve_problem respond.\n- Testing level (highest first): E2E, black box or golden file regression, then unit tests of a module or component with complete outward behaviour, and only last a fine-grained single-function unit. A \"unit\" is never a single function: never write one unit test per function, and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail. A tautological test that restates the production logic is forbidden, and a test that stays green while the behaviour is wrong is not a test. Hold yourself to this: renaming, splitting or restructuring internals keeps the suite green without rewriting tests.\n- Shared mutable state (the Pi extension install root, caches, a worktree base) changes only under a serialization lock keyed on the canonical path, and never by deleting or rebuilding a shared tree while handling one object that lives in it. A static signal - a changed file list, a declared-but-unshipped entry point - is a diagnostic only; a destructive action needs evidence from the affected object itself (npm logs, lockfiles, a real load). Tests assert invariants, never dispatch or queue order.",
	},
	"runtime/worker.md": {
		"Use the native Pi tools to read, search, edit and run commands in the assigned worktree. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. Native bash is sandboxed by the workspace and host access policy.{{retrievalNote}}",
		"Use workspace tools to read and edit files. Use artifact_list/read to discover published task knowledge and artifact_publish for reports, plans, source lists and other shared deliverables that are not code changes. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.{{retrievalNote}}",
	},
	"rules/worker.md": {
		"Work only inside the assigned task and worktree. Keep the change scoped to the requested outcome and the confirmed acceptance criteria.\nRead the task graph and the predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.\nRun the checks assigned to that node, and submit structured results only when the work and its evidence are complete.\nStay inside the file list of your node, and only that list. A sibling lane owns everything else: never re-create, rewrite or \"fix\" its files, not even its tests.\nA `graph.command` check runs in the host sandbox, so a test written for a check must be pure logic: no playwright/jsdom, no listening sockets, no child processes. Browser and DOM behaviour is covered by the human acceptance check, never by a check test.\nIf your work copy already contains files you do not own - a sibling lane's - restore them to the integration tip (`git checkout <integration sha> -- <paths>`) before committing. Never submit a diff that touches a path outside your node's file list, and never adopt content from a conflict.\nDo not modify shared Graph state, credentials, or another Agent's worktree.",
		"Work only inside the assigned task and worktree. Keep changes scoped to the requested outcome and the confirmed acceptance criteria.\nRead the task graph and predecessor handoff before editing. Implement the smallest complete change that satisfies the assigned node.\nRun the checks assigned to the node and submit structured results only when the work and evidence are complete.\nPrefer task-scoped changes; modify shared Graph state, credentials, or another Agent worktree only when the request explicitly requires it.\nChoose the highest test level that can prove the behaviour: E2E, black box or golden file regression first, then unit tests of a module or component with complete outward behaviour, and a fine-grained single-function unit only when nothing higher can prove it. Never write one unit test per function and never mock a crowd of dependencies to isolate one function. A golden file compares only the final output, and a snapshot change must be deliberate and justified. Unit tests assert outward behaviour only - never a private variable, an internal function or an implementation detail - and a tautological test that restates the production logic is forbidden. A refactor of internals must keep the suite green without rewriting tests; if it forces a large rewrite, the tests were written against implementation details.",
	},
	"rules/reviewer.md": {
		"Review only the frozen evidence and exact versions supplied by the graph. Do not inspect the implementation transcript.\nLook for defects, regressions, unsupported claims, and acceptance gaps before stylistic suggestions.\nShow file paths, evidence, and concrete impact for every finding.\nDo not modify implementation files. Return an independent verdict that the verifier can evaluate.\nJudge the level of the tests too: E2E, black box or golden file regression first, then units of a whole module or component, and a single-function unit only when nothing higher can prove the behaviour. Flag as defects: one unit test per function, heavy dependency mocking to isolate one function, assertions on private variables, internal functions or implementation details, and tautological tests that restate the production logic. A golden file must compare only the final output, and every snapshot change must be deliberate and justified.",
	},
}

var agentLegacyPromptReplacements = map[AgentPromptKey][][2]string{
	"runtime/sediment.md": {
		{"Answer with one JSON object and nothing else:", "Answer with one line of metadata, then the skill itself:"},
		{"{\"action\":\"create\"|\"update\"|\"nothing\",\"id\":\"<lowercase-slug>\",\"description\":\"<one sentence saying when to use it>\",\"body\":\"<markdown>\",\"reason\":\"<one line>\"}", "{\"action\":\"create\"|\"update\"|\"nothing\",\"id\":\"<lowercase-slug>\",\"description\":\"<one sentence saying when to use it>\",\"reason\":\"<one line>\"}\nKeep that line to metadata only — never put markdown in it. When the action is create or update, follow it with the skill in a fenced block:\n```markdown\n<the skill: the procedure in order, the commands that work, the pitfalls>\n```"},
		{"body is markdown, at most 20000 characters, and is the skill itself.", "The fenced block is the skill itself: markdown, at most 20000 characters, the thing a future operation follows."},
	},
}

// agentContextUniqueSorted removes duplicates and sorts the names.
func agentContextUniqueSorted(values []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, value := range values {
		if seen[value] {
			continue
		}
		seen[value] = true
		out = append(out, value)
	}
	sort.Strings(out)
	return out
}

// agentContextDefaultDisabledTools are the tools that are off until the user says otherwise.
var agentContextDefaultDisabledTools = []string{"powershell"}
