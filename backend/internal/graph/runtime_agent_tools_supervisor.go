package graph

import (
	"strings"

	"errors"
)

// agentToolsSupervisorHandlers are the handlers of the Supervisor tools.
func agentToolsSupervisorHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"validate_proposal": func(id string, params map[string]any) any {
			// The master asks whether a proposal would be accepted. A refusal
			// is the answer to that question, not a failed tool call: the
			// model has to read which rule refused it and try again.
			answer := any(nil)
			refusal := func() (failure *RuntimeError) {
				defer func() {
					recovered := recover()
					if recovered == nil {
						return
					}
					if err, ok := recovered.(*RuntimeError); ok {
						failure = err
						return
					}
					panic(recovered)
				}()
				proposal := agentToolsNativeProposal(params["proposal"])
				answer = input.Supervisor.ValidateProposal(proposal)
				return nil
			}()
			if refusal != nil {
				return agentToolsText(stringifyJSON(map[string]any{
					"valid": false,
					"error": map[string]any{"code": refusal.Code, "message": refusal.Message},
				}))
			}
			return agentToolsText(stringifyJSON(answer))
		},
		"get_graph_state": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.GraphState()))
		},
		"get_task_status": func(id string, params map[string]any) any {
			taskId := agentToolsOptionalString(params, "taskId")
			nodeId := agentToolsOptionalString(params, "nodeId")
			waitForNode := agentToolsOptionalString(params, "waitForNode")
			var timeoutMs *int
			if value, ok := agentToolsNumber(params["timeoutMs"]); ok {
				truncated := int(value)
				timeoutMs = &truncated
			}
			if _, present := params["graphId"]; present {
				corrected := map[string]any{"taskId": "<graph id>"}
				if taskId != nil {
					corrected["taskId"] = *taskId
				} else if graphId := agentToolsOptionalString(params, "graphId"); graphId != nil {
					corrected["taskId"] = *graphId
				}
				if nodeId != nil {
					corrected["nodeId"] = *nodeId
				}
				if waitForNode != nil {
					corrected["waitForNode"] = *waitForNode
				}
				if timeoutMs != nil {
					corrected["timeoutMs"] = *timeoutMs
				}
				Raise("invalid_input", "get_task_status uses taskId, not graphId. Retry get_task_status("+
					stringifyJSON(corrected)+") with graphId removed.")
			}
			return agentToolsText(stringifyJSON(input.Supervisor.TaskStatus(PiAdapterTaskStatus{
				TaskId: taskId, NodeId: nodeId, WaitForNode: waitForNode, TimeoutMs: timeoutMs,
			})))
		},
		"list_projects": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.ListProjects()))
		},
		"bind_project": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.BindProject(PiAdapterBindProject{
				ProjectId: strings.TrimSpace(agentToolsString(params["projectId"])),
				RequestId: strings.TrimSpace(agentToolsString(params["requestId"])),
			})))
		},
		"list_problems": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.ListProblems()))
		},
		"list_human_checks": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.PendingHumanChecks()))
		},
		"review_human_check": func(id string, params map[string]any) any {
			approve, ok := params["approve"].(bool)
			if !ok {
				panic(errors.New("review_human_check requires approve as a boolean"))
			}
			return agentToolsText(stringifyJSON(input.ReviewHumanCheck(AgentToolsHumanCheck{
				QuestionId: strings.TrimSpace(agentToolsString(params["questionId"])),
				Approve:    approve,
				Note:       strings.TrimSpace(agentToolsStringOrEmpty(params["note"])),
				RequestId:  strings.TrimSpace(agentToolsString(params["requestId"])),
			})))
		},
		"resolve_problem": func(id string, params map[string]any) any {
			action := strings.TrimSpace(agentToolsStringOrEmpty(params["action"]))
			if !agentToolsContains(agentToolsProblemActions, action) {
				panic(errors.New("Unsupported problem action"))
			}
			resolve := PiAdapterResolveProblem{
				QuestionId: strings.TrimSpace(agentToolsString(params["questionId"])),
				Action:     action,
				RequestId:  strings.TrimSpace(agentToolsString(params["requestId"])),
			}
			if response, ok := params["response"].(string); ok {
				value := strings.TrimSpace(response)
				resolve.Response = &value
			}
			if proof, ok := params["proof"].(string); ok {
				value := strings.TrimSpace(proof)
				resolve.Proof = &value
			}
			return agentToolsText(stringifyJSON(input.Supervisor.ResolveProblem(resolve)))
		},
	}
}
