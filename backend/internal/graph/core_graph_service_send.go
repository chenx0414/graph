package graph

import (
	"fmt"
)

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
