package graph

func agentControlDeclarations(set agentToolContext) []AgentToolDeclaration {
	available := set.features.AgentControl
	return []AgentToolDeclaration{
		{Name: "read_agent", Label: "Read an Agent", Description: "Read a descendant Agent's recent messages. Use sinceSeq and nextSeq for subsequent pages. Content is bounded; contentTruncated marks excerpts.", Parameters: tbObject([]tbField{{"agentId", tbString(nil)}, {"sinceSeq", tbOptional(tbNumber())}, {"limit", tbOptional(tbNumber())}}, []string{"agentId"}), Available: available},
		{Name: "list_children", Label: "List child Agents", Description: "List direct children and their current state. Defaults to your own children; agentId may name a descendant. Continue using afterId=nextAfterId when hasMore is true.", Parameters: tbObject([]tbField{{"agentId", tbOptional(tbString(nil))}, {"limit", tbOptional(tbNumber())}, {"afterId", tbOptional(tbString(nil))}}, nil), Available: available},
		{Name: "message_agent", Label: "Message an Agent", Description: "Append work to a descendant Agent's durable serial queue. Busy or paused Agents retain it for a later turn. Reuse requestId only for the same message.", Parameters: tbObject([]tbField{{"agentId", tbString(nil)}, {"text", tbString(nil)}, {"requestId", tbString(nil)}}, []string{"agentId", "text", "requestId"}), Available: available},
		{Name: "stop_agent", Label: "Stop an Agent", Description: "Pause a descendant Agent's queue and interrupt its current execution. Preserve its identity, history and queued messages.", Parameters: tbObject([]tbField{{"agentId", tbString(nil)}, {"reason", tbOptional(tbString(nil))}, {"requestId", tbString(nil)}}, []string{"agentId", "requestId"}), Available: available},
	}
}

func agentToolsControlHandlers(input AgentToolsInput) map[string]func(string, map[string]any) any {
	handlers := map[string]func(string, map[string]any) any{}
	for _, action := range []string{"read_agent", "list_children", "message_agent", "stop_agent"} {
		handlers[action] = func(_ string, params map[string]any) any {
			request := AgentControlInput{Action: action, AgentId: agentToolsStringOrEmpty(params["agentId"]), AfterId: agentToolsStringOrEmpty(params["afterId"]), Text: agentToolsStringOrEmpty(params["text"]), Reason: agentToolsStringOrEmpty(params["reason"]), RequestId: agentToolsStringOrEmpty(params["requestId"])}
			if value, exists := params["limit"]; exists {
				request.Limit = agentControlInteger(value, "limit", 1, 200)
			}
			if value, exists := params["sinceSeq"]; exists {
				sequence := agentControlInteger(value, "sinceSeq", 0, 9007199254740991)
				request.SinceSeq = &sequence
			}
			if action == "message_agent" || action == "stop_agent" {
				if request.RequestId == "" || len(request.RequestId) > 100 {
					Raise("invalid_input", "A requestId of 1–100 characters is required")
				}
				if action == "message_agent" && (request.Text == "" || len([]rune(request.Text)) > 100000) {
					Raise("invalid_input", "A message of 1–100000 characters is required")
				}
			}
			return agentToolsText(CanonicalJSON(input.ControlAgent(request)))
		}
	}
	return handlers
}

func agentControlInteger(value any, name string, min, max int) int {
	number, ok := value.(float64)
	if !ok || !isSafeInteger(number) || number < float64(min) || number > float64(max) {
		Raise("invalid_input", name+" must be a bounded integer")
	}
	return int(number)
}
