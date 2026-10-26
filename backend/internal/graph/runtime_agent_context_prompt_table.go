package graph

import (
	"regexp"
)

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
