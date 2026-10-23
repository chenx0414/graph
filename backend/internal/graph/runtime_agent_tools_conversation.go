package graph

import (
	"errors"
	"strings"
)

// The Conversation tool group of the Agent tool table.
//
// The table was one map inside one function; every handler body here is the
// text that was there before, moved. The group function takes the values the
// closures captured as named parameters, so the moved bodies are unchanged.

// agentToolsConversationHandlers are the handlers of the Conversation tools.
func agentToolsConversationHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"ask_user": func(id string, params map[string]any) any {
			prompt := strings.TrimSpace(agentToolsStringOrEmpty(params["prompt"]))
			why := strings.TrimSpace(agentToolsStringOrEmpty(params["why"]))
			if prompt == "" {
				panic(errors.New("A question is required"))
			}
			if why == "" {
				panic(errors.New("Say what would change with the answer: a question nobody can act on is not worth the user turn"))
			}
			if input.OnAskUser == nil {
				panic(errors.New("This Agent session cannot ask the user"))
			}
			options := []string{}
			if raw, ok := params["options"].([]any); ok {
				for _, item := range raw {
					value := strings.TrimSpace(agentToolsString(item))
					if value == "" {
						continue
					}
					if len(value) > 300 {
						value = value[:300]
					}
					if !agentToolsContains(options, value) {
						options = append(options, value)
					}
				}
				if len(options) > 8 {
					options = options[:8]
				}
			}
			input.OnAskUser(PiAdapterAskedQuestion{
				Prompt: agentToolsTruncate(prompt, 2_000), Why: agentToolsTruncate(why, 1_000),
				Options: options, Multiple: params["multiple"] == true,
			})
			// The turn stops here on purpose: the answer is the next turn's input.
			result := agentToolsText(stringifyJSON(map[string]any{"status": "asked", "prompt": prompt}))
			result["terminate"] = true
			return result
		},
		"conversation_read": func(id string, params map[string]any) any {
			if input.Conversations.List == nil {
				panic(errors.New("This Agent session cannot reach other conversations"))
			}
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if action == "list" {
				var archived *bool
				if value, ok := params["archived"].(bool); ok && value {
					archived = &value
				}
				return agentToolsText(stringifyJSON(input.Conversations.List(archived)))
			}
			conversationID := strings.TrimSpace(agentToolsStringOrEmpty(params["conversationId"]))
			if conversationID == "" {
				panic(errors.New("conversationId is required for read and follow"))
			}
			if action == "read" {
				return agentToolsText(stringifyJSON(input.Conversations.Read(conversationID,
					agentToolsBoundedNumber(params["limit"], 50), agentToolsBoundedNumber(params["after"], 0))))
			}
			if action == "follow" {
				return agentToolsText(stringifyJSON(input.Conversations.Follow(conversationID,
					agentToolsBoundedNumber(params["after"], 0), agentToolsBoundedNumber(params["limit"], 100))))
			}
			panic(errors.New("Unsupported read action: use list, read or follow"))
		},
		"conversation_write": func(id string, params map[string]any) any {
			if input.Conversations.Send == nil {
				panic(errors.New("This Agent session cannot reach other conversations"))
			}
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			conversationID := strings.TrimSpace(agentToolsStringOrEmpty(params["conversationId"]))
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if conversationID == "" {
				panic(errors.New("conversationId is required"))
			}
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			if action == "send" || action == "steer" {
				message := strings.TrimSpace(agentToolsStringOrEmpty(params["text"]))
				if message == "" {
					panic(errors.New("text is required for " + action))
				}
				if action == "send" {
					return agentToolsText(stringifyJSON(input.Conversations.Send(conversationID, message, requestID)))
				}
				return agentToolsText(stringifyJSON(input.Conversations.Steer(conversationID, message, requestID)))
			}
			if action == "pause" {
				return agentToolsText(stringifyJSON(input.Conversations.Pause(conversationID, requestID)))
			}
			if action == "resume" {
				return agentToolsText(stringifyJSON(input.Conversations.Resume(conversationID, requestID)))
			}
			panic(errors.New("Unsupported write action: use send, steer, pause or resume"))
		},
		"list_peers": func(id string, params map[string]any) any {
			if peers == nil {
				panic(errors.New("This Agent session has no graph peers"))
			}
			return agentToolsText(stringifyJSON(map[string]any{"peers": peers.list()}))
		},
		"send_to_peer": func(id string, params map[string]any) any {
			if peers == nil {
				panic(errors.New("This Agent session has no graph peers"))
			}
			to := strings.TrimSpace(agentToolsStringOrEmpty(params["to"]))
			message := strings.TrimSpace(agentToolsStringOrEmpty(params["text"]))
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if to == "" {
				panic(errors.New("to is required: name a peer node id (list_peers shows them)"))
			}
			if message == "" {
				panic(errors.New("text is required"))
			}
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			return agentToolsText(stringifyJSON(peers.send(PiAdapterPeerRequest{
				To: to, Text: message, RequestId: requestID,
			})))
		},
		"control_task": func(id string, params map[string]any) any {
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if !agentToolsContains(agentToolsControlActions, action) {
				panic(errors.New("Unsupported control action: use pause, resume, abandon, set_budget or steer"))
			}
			if input.ControlTask == nil {
				panic(errors.New("This Agent session cannot control tasks"))
			}
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			control := AgentToolsControlTask{Action: action, RequestId: requestID}
			if raw, ok := params["taskId"].(string); ok && strings.TrimSpace(raw) != "" {
				value := strings.TrimSpace(raw)
				control.TaskId = &value
			}
			if raw, ok := params["nodeId"].(string); ok && strings.TrimSpace(raw) != "" {
				value := strings.TrimSpace(raw)
				control.NodeId = &value
			}
			if raw, ok := params["text"].(string); ok {
				value := raw
				control.Text = &value
			}
			if raw, present := params["tokens"]; present {
				if raw == nil {
					control.Tokens = nil
				} else if value, ok := agentToolsNumber(raw); ok {
					tokens := int(value)
					control.Tokens = &tokens
				}
			}
			if raw, ok := params["reason"].(string); ok {
				value := raw
				control.Reason = &value
			}
			receipt := input.ControlTask(control)
			result := agentToolsText(stringifyJSON(receipt))
			// Abandoning ends the task, so there is nothing left to continue in this turn.
			if action == "abandon" {
				result["terminate"] = true
			}
			return result
		},
	}
}
