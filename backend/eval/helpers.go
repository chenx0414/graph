package eval

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

func definitionOf(t *T, text string) any {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		t.Fatal("definition", err)
	}
	return value
}

func sortedKeys(values map[string]map[string]any) []string {
	collected := make([]string, 0, len(values))
	for key := range values {
		collected = append(collected, key)
	}
	sort.Strings(collected)
	return collected
}

func sortedIDs(nodes []graphNodeView) []string {
	collected := make([]string, 0, len(nodes))
	for _, node := range nodes {
		collected = append(collected, node.ID)
	}
	sort.Strings(collected)
	return collected
}

func sortedTopologyNodes(view graphTopologyView) []string {
	collected := make([]string, 0, len(view.Nodes))
	for _, node := range view.Nodes {
		collected = append(collected, node.ID)
	}
	sort.Strings(collected)
	return collected
}

func sortedTopologyEdges(view graphTopologyView) []string {
	collected := make([]string, 0, len(view.Edges))
	for _, edge := range view.Edges {
		collected = append(collected, edge.ID)
	}
	sort.Strings(collected)
	return collected
}

func containsText(text, wanted string) bool {
	return strings.Contains(text, wanted)
}

func graphPhaseOf(state map[string]any) string {
	if phase, ok := state["phase"].(string); ok {
		return phase
	}
	if graph, ok := state["graph"].(map[string]any); ok {
		if phase, ok := graph["phase"].(string); ok {
			return phase
		}
	}
	return ""
}

func errorText(text string) error { return errors.New(text) }

func renderString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func renderPtr(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

type createdConversation struct {
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
}

func firstMessageText(messages []map[string]any) string {
	for _, message := range messages {
		if text := renderString(message["text"]); text != "" {
			return text
		}
	}
	return ""
}
