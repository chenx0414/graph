package graph

import (
	"encoding/json"
	"fmt"
	"strings"
)

// graphSendValue reads the value one agent sent to a graph input.
//
// Measured 2026-11-04: a model that has an object to hand over sometimes
// encodes it as a JSON string ("value": "{\"commit\":\"a5df4002\"}"), and the
// graph's input protocol then refuses the delivery with "must be object,
// received a string" no matter how carefully the shape is described. Only an
// encoded object or array is decoded: a plain string stays itself, so a text
// value is never rewritten into something else.
func graphSendValue(value any) any {
	text, ok := value.(string)
	if !ok {
		return value
	}
	trimmed := strings.TrimSpace(text)
	if !strings.HasPrefix(trimmed, "{") && !strings.HasPrefix(trimmed, "[") {
		return value
	}
	var parsed any
	if err := json.Unmarshal([]byte(trimmed), &parsed); err != nil {
		return value
	}
	switch parsed.(type) {
	case map[string]any, []any:
		return parsed
	}
	return value
}

// GraphSend delivers a public input or a chat message to a graph.
func (service *graphManagementService) GraphSend(input GraphSendInput) any {
	graph := service.runtime(input.GraphId)
	if input.Input != nil {
		endpoint := ""
		if input.NodeId != nil && *input.NodeId != "" {
			endpoint = *input.NodeId + "." + *input.Input
		} else if latest := service.kernel.LatestRevision(input.GraphId); latest != nil {
			if declared, ok := latest.Definition.Inputs[*input.Input]; ok {
				endpoint = declared.To
			}
		}
		if endpoint == "" {
			Raise("invalid_input", "Unknown public input "+*input.Input)
		}
		return graph.DeliverEndpoint(endpoint, input.Value)
	}
	if input.NodeId == nil || *input.NodeId == "" {
		Raise("invalid_input", "Chat requires nodeId")
	}
	text := ""
	if input.Text != nil {
		text = *input.Text
	}
	return graph.Chat(*input.NodeId, text, false)
}

func graphServiceId(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func graphServiceOptionalNumber(value *int) any {
	if value == nil {
		return nil
	}
	return *value
}

func graphServiceErrorMessage(recovered any) string {
	if err, ok := recovered.(error); ok {
		return err.Error()
	}
	return fmt.Sprint(recovered)
}
