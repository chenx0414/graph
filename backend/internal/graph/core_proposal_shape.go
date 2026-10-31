package graph

import (
	"sort"
	"strings"
)

// ProposalShapeNotes says where a draft spends a node without buying anything.
//
// It is advice, never a gate: whether a node earns its place is a judgement
// call, and a gate would only teach authors to phrase around it. The notes are
// mechanical so they cannot be argued away - a node nobody mentions, two nodes
// doing the same job, a node wired to nothing - and the author answers them in
// the draft or drops the node.
func ProposalShapeNotes(proposal NativeProposal) []string {
	definition := proposal.Definition
	ids := make([]string, 0, len(definition.Nodes))
	for id := range definition.Nodes {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	// One node is the baseline: there is nothing to justify until a draft spends
	// a second one.
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

// endpointNode reads the node of a "node.port" endpoint.
func endpointNode(endpoint string) string {
	if at := strings.Index(endpoint, "."); at >= 0 {
		return endpoint[:at]
	}
	return endpoint
}
