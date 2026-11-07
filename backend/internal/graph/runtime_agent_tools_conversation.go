package graph

import (
	"strings"

	"errors"
)

func agentToolsConversationHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"ask_supervisor": func(id string, params map[string]any) any {
			return agentToolsSupervisor(input.OnAskSupervisor, input.OnNotifySupervisor, params)
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
				panic(errors.New("Unsupported control action: use pause, resume, abandon, set_budget, steer or stop_node"))
			}
			if input.ControlTask == nil {
				panic(errors.New("This Agent session cannot control tasks"))
			}
			requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
			if requestID == "" {
				panic(errors.New("A bounded requestId is required"))
			}
			control := AgentToolsControlTask{Action: action, RequestId: requestID}
			control.SourceMessageID = agentToolsStringOrEmpty(params["sourceMessageId"])
			control.Instruction = agentToolsStringOrEmpty(params["instruction"])
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
			if action == "abandon" {
				result["terminate"] = true
			}
			return result
		},
	}
}

func agentToolsAsk(ask func(PiAdapterAskedQuestion), params map[string]any) any {
	prompt := strings.TrimSpace(agentToolsStringOrEmpty(params["prompt"]))
	why := strings.TrimSpace(agentToolsStringOrEmpty(params["why"]))
	if prompt == "" {
		panic(errors.New("A question is required"))
	}
	if why == "" {
		panic(errors.New("Say what would change with the answer: a question nobody can act on is not worth the user turn"))
	}
	if ask == nil {
		panic(errors.New("This Agent session cannot ask the user"))
	}
	requestID := strings.TrimSpace(agentToolsStringOrEmpty(params["requestId"]))
	if requestID == "" || len(requestID) > 200 {
		panic(errors.New("A bounded requestId is required"))
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
	recommended := strings.TrimSpace(agentToolsStringOrEmpty(params["recommended"]))
	if recommended != "" && !agentToolsContains(options, recommended) {
		panic(errors.New("A recommended option must be one of the options"))
	}
	ask(PiAdapterAskedQuestion{
		Prompt: agentToolsTruncate(prompt, 2_000), Why: agentToolsTruncate(why, 1_000),
		Options: options, Recommended: recommended, Multiple: params["multiple"] == true, RequestID: requestID,
	})
	result := agentToolsText(stringifyJSON(map[string]any{"status": "asked", "prompt": prompt}))
	result["terminate"] = true
	return result
}
