package graph

import (
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"encoding/json"
)

func nodeRunCapabilities(store *TaskStore, taskId, nodeId string, spec nodeRunSpec, taskPhase string) ([]NodeCapabilityView, *string) {
	empty := []NodeCapabilityView{}
	if spec.DefinitionVersion == nil || *spec.DefinitionVersion == "" {
		return empty, nil
	}
	match := nodeRunDefinitionMatch.FindStringSubmatch(*spec.DefinitionVersion)
	if match == nil {
		return empty, nil
	}
	version, err := strconv.Atoi(match[2])
	if err != nil {
		return empty, nil
	}
	definition := kernelRow(store.Db, "SELECT spec FROM definitions WHERE id=? AND version=?", match[1], version)
	if definition == nil {
		return empty, nil
	}
	var parsed nodeRunDefinitionSpec
	if err := json.Unmarshal([]byte(kernelString(definition["spec"])), &parsed); err != nil {
		panic(err)
	}
	factRow := kernelRow(store.Db, "SELECT loaded,read_only FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1", taskId, nodeId)
	facts := map[string]CapabilityLoadFact{}
	var capabilityDigest *string
	if factRow != nil {
		loaded := parseJSON(kernelString(factRow["loaded"]))
		if list, ok := loaded.([]any); ok {
			for _, item := range list {
				fact := nodeRunCapabilityFact(item)
				facts[fact.ID+"@"+fact.Version] = fact
			}
		} else if record := asMap(loaded); record != nil {
			if digest, ok := record["digest"].(string); ok {
				value := digest
				capabilityDigest = &value
			}
			for _, item := range asSlice(record["facts"]) {
				fact := nodeRunCapabilityFact(item)
				facts[fact.ID+"@"+fact.Version] = fact
			}
		}
	}
	bindings := []nodeRunBinding{}
	for _, bound := range parsed.Capabilities {
		bindings = append(bindings, nodeRunBinding{ID: bound.ID, Version: bound.Version})
	}
	if parsed.Prompts != nil && parsed.Prompts.Agent != nil {
		bindings = append(bindings, nodeRunBinding{ID: parsed.Prompts.Agent.ID, Version: parsed.Prompts.Agent.Version})
	}
	if parsed.Prompts != nil && parsed.Prompts.Tool != nil {
		bindings = append(bindings, nodeRunBinding{ID: parsed.Prompts.Tool.ID, Version: parsed.Prompts.Tool.Version})
	}
	views := make([]NodeCapabilityView, 0, len(bindings))
	for _, bound := range bindings {
		views = append(views, nodeRunCapabilityView(store, bound, facts, factRow != nil, spec, taskPhase))
	}
	return views, capabilityDigest
}

func nodeRunCapabilityFact(item any) CapabilityLoadFact {
	raw, err := json.Marshal(item)
	if err != nil {
		panic(err)
	}
	var fact CapabilityLoadFact
	if err := json.Unmarshal(raw, &fact); err != nil {
		panic(err)
	}
	return fact
}

func nodeRunCapabilityView(store *TaskStore, bound nodeRunBinding, facts map[string]CapabilityLoadFact, hasFactRow bool, spec nodeRunSpec, taskPhase string) NodeCapabilityView {
	catalog := kernelRow(store.Db, "SELECT kind,source,snapshot FROM capabilities WHERE id=? AND version=?", bound.ID, bound.Version)
	catalogName := bound.ID
	if catalog != nil {
		if snapshot, ok := parseJSONDocument(kernelString(catalog["snapshot"])); ok {
			if record := asMap(snapshot); record != nil {
				if name, ok := record["name"].(string); ok && strings.TrimSpace(name) != "" {
					catalogName = name
				}
			}
		}
	}
	fact, hasFact := facts[bound.ID+"@"+bound.Version]
	remote := false
	if catalog != nil && kernelString(catalog["kind"]) == "mcp" {
		remote = nodeRunRemoteMCP(kernelString(catalog["source"]))
	}
	master := spec.Role != nil && *spec.Role == "master"
	if !hasFact && !hasFactRow && remote && master && (taskPhase == "chatting" || taskPhase == "discussing") {
		loaded := false
		executable := false
		reason := "只读讨论模式不加载远程能力"
		kind := "mcp"
		return NodeCapabilityView{
			ID: bound.ID, Version: bound.Version, Kind: &kind, Name: catalogName, Tools: []string{},
			Bound: true, Loaded: &loaded, Executable: &executable, State: "禁用", Reason: &reason,
		}
	}
	if !hasFact {
		var kind *string
		if catalog != nil {
			value := kernelString(catalog["kind"])
			kind = &value
		}
		state := "未记录"
		reason := "该节点没有能力加载记录（历史或尚未运行）"
		if hasFactRow {
			state = "未加载"
			reason = "本次运行未加载该能力"
		}
		return NodeCapabilityView{
			ID: bound.ID, Version: bound.Version, Kind: kind, Name: catalogName, Tools: []string{},
			Bound: true, Loaded: nil, Executable: nil, State: state, Reason: &reason,
		}
	}
	name := catalogName
	if fact.Name != nil {
		name = *fact.Name
	}
	tools := fact.Tools
	if tools == nil {
		tools = []string{}
	}
	loaded := fact.Loaded
	executable := fact.Executable
	state := "禁用"
	if fact.Loaded {
		if fact.Executable {
			state = "可执行"
		} else {
			state = "已加载"
		}
	}
	return NodeCapabilityView{
		ID: fact.ID, Version: fact.Version, Kind: fact.Kind, Name: name, Tools: tools,
		Bound: true, Loaded: &loaded, Executable: &executable, State: state, Reason: fact.Reason,
	}
}

func nodeRunRemoteMCP(source string) bool {
	raw, err := os.ReadFile(filepath.Join(source, "capability.json"))
	if err != nil {
		return false
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return false
	}
	_, hasCommand := manifest["command"].(string)
	return !hasCommand
}

func nodeRunCapabilityUsage(store *TaskStore, taskId, nodeId string, facts []NodeCapabilityView) []CapabilityUsageFact {
	rows := kernelRows(store.Db, `SELECT kind,data,created_at FROM node_entries
    WHERE task_id=? AND node_id=? AND role='tool' AND kind IN ('call','result') ORDER BY seq`, taskId, nodeId)
	type toolCall struct {
		toolName string
		calledAt int64
		failed   bool
		settled  bool
	}
	calls := map[string]*toolCall{}
	for _, row := range rows {
		raw := kernelString(row["data"])
		if raw == "" {
			continue
		}
		data := asMap(parseJSON(raw))
		if data == nil {
			continue
		}
		toolCallID, ok := data["toolCallId"].(string)
		if !ok || toolCallID == "" {
			continue
		}
		if kernelString(row["kind"]) == "call" {
			toolName, ok := data["toolName"].(string)
			if !ok || toolName == "" {
				continue
			}
			calls[toolCallID] = &toolCall{toolName: toolName, calledAt: kernelInt(row["created_at"])}
			continue
		}
		if call, ok := calls[toolCallID]; ok {
			call.failed = data["isError"] == true
			call.settled = true
		}
	}
	toolOwners := map[string]string{}
	for _, fact := range facts {
		for _, tool := range fact.Tools {
			toolOwners[tool] = fact.ID + "@" + fact.Version
		}
	}
	type toolStat struct {
		calls        int
		successes    int
		failures     int
		pending      int
		lastCalledAt *int64
	}
	stats := map[string]*toolStat{}
	for _, call := range calls {
		owner, ok := toolOwners[call.toolName]
		if !ok {
			continue
		}
		current, ok := stats[owner]
		if !ok {
			current = &toolStat{}
			stats[owner] = current
		}
		current.calls++
		switch {
		case !call.settled:
			current.pending++
		case call.failed:
			current.failures++
		default:
			current.successes++
		}
		if current.lastCalledAt == nil || call.calledAt > *current.lastCalledAt {
			value := call.calledAt
			current.lastCalledAt = &value
		}
	}
	out := make([]CapabilityUsageFact, 0, len(facts))
	for _, fact := range facts {
		current, ok := stats[fact.ID+"@"+fact.Version]
		if !ok {
			current = &toolStat{}
		}
		settled := current.successes + current.failures
		var successRate *float64
		if settled > 0 {
			value := float64(current.successes) / float64(settled)
			successRate = &value
		}
		tools := fact.Tools
		if tools == nil {
			tools = []string{}
		}
		out = append(out, CapabilityUsageFact{
			ID: fact.ID, Version: fact.Version, Kind: fact.Kind, Name: fact.Name, Tools: tools,
			Calls: current.calls, Successes: current.successes, Failures: current.failures,
			Pending: current.pending, LastCalledAt: current.lastCalledAt, SuccessRate: successRate,
		})
	}
	return out
}
