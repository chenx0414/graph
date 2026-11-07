package graph

import (
	"sort"
	"strings"
)

func ProposalShapeNotes(proposal NativeProposal) []string {
	definition := proposal.Definition
	ids := make([]string, 0, len(definition.Nodes))
	for id := range definition.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	if len(ids) < 2 {
		return nil
	}

	spoken := strings.ToLower(proposal.Summary + "\n" + strings.Join(proposal.Decisions, "\n"))
	wired := map[string]bool{}
	for _, edge := range definition.Edges {
		if !edge.Enabled {
			continue
		}
		wired[endpointNode(edge.From)] = true
		wired[endpointNode(edge.To)] = true
	}
	for _, input := range definition.Inputs {
		wired[endpointNode(input.To)] = true
	}
	for _, output := range definition.Outputs {
		wired[endpointNode(output.From)] = true
	}

	notes := []string{}
	byIntent := map[string][]string{}
	for _, id := range ids {
		node := definition.Nodes[id]
		if !strings.Contains(spoken, strings.ToLower(id)) {
			notes = append(notes, "节点 "+id+" 在 summary/decisions 里没有被提到：说不出它带来的新信息就删掉它")
		}
		if !wired[id] {
			notes = append(notes, "节点 "+id+" 没有连到任何输入、输出或边")
		}
		if intent := strings.TrimSpace(node.Recipe) + "|" + strings.TrimSpace(node.Task); strings.TrimSpace(node.Task) != "" {
			byIntent[intent] = append(byIntent[intent], id)
		}
	}

	intents := make([]string, 0, len(byIntent))
	for intent := range byIntent {
		intents = append(intents, intent)
	}
	sort.Strings(intents)
	for _, intent := range intents {
		group := byIntent[intent]
		if len(group) > 1 {
			notes = append(notes, "节点 "+strings.Join(group, "、")+" 用同一个 recipe 与同样的 task：做同一件事就留一个，做不同的事就把差别写进 task")
		}
	}
	return notes
}

func endpointNode(endpoint string) string {
	if at := strings.Index(endpoint, "."); at >= 0 {
		return endpoint[:at]
	}
	return endpoint
}
