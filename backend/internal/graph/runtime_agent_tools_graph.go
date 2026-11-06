package graph

import (
	"strings"
)

// agentToolsGraphHandlers are the handlers of the Graph tools.
func agentToolsGraphHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
		"resume_work": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.Supervisor.ResumeWork(WorkResumeInstruction{WorkID: agentToolsString(params["workId"]), RequestID: agentToolsString(params["requestId"]), SourceMessageID: agentToolsString(params["sourceMessageId"]), Instruction: agentToolsString(params["instruction"])})))
		},
		"read_work_draft": func(id string, params map[string]any) any {
			version, ok := agentToolsNumberValue(params["version"])
			if !ok || version < 1 || version > 9007199254740991 || float64(int64(version)) != version {
				Raise("invalid_input", "version must be a positive integer")
			}
			return agentToolsText(stringifyJSON(input.Supervisor.ReadWorkDraft(agentToolsString(params["workId"]), int64(version))))
		},
		"propose_work_graph": func(id string, params map[string]any) any {
			draftInput := WorkDraftToolInput{WorkID: agentToolsString(params["workId"]), RequestID: agentToolsString(params["requestId"])}
			revision, ok := agentToolsNumberValue(params["workRevision"])
			if !ok || revision < 1 || float64(int64(revision)) != revision {
				Raise("invalid_input", "workRevision must be a positive integer")
			}
			draftInput.Draft.WorkRevision = int64(revision)
			if value, present := params["expectedDraftRevision"]; present {
				v, valid := agentToolsNumberValue(value)
				if !valid || v < 1 || float64(int64(v)) != v {
					Raise("invalid_input", "expectedDraftRevision must be a positive integer")
				}
				number := int64(v)
				draftInput.Draft.ExpectedDraftRevision = &number
			}
			draftInput.Draft.NewVersion = params["newVersion"] == true
			proposal, ok := jsonRecord(params["proposal"])
			if !ok {
				Raise("invalid_input", "A proposal object is required")
			}
			draftInput.Draft.Proposal = proposal
			return agentToolsText(stringifyJSON(input.Supervisor.ProposeWorkGraph(draftInput)))
		},
		"graph_create": func(id string, params map[string]any) any {
			body := map[string]any{}
			for key, value := range params {
				body[key] = value
			}
			requestID, present := params["requestId"]
			if !present || requestID == nil {
				body["requestId"] = id
			}
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphCreate(body)))
		},
		"graph_patch": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphPatch(params)))
		},
		"read_graph": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.ReadGraph(agentToolsGraphSectionQuery(params))))
		},
		"graph_inspect": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphInspect(params)))
		},
		"graph_control": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphControl(params)))
		},
		"graph_send": func(id string, params map[string]any) any {
			return agentToolsText(stringifyJSON(input.GraphManagement.GraphSend(params)))
		},
		"propose_graph": func(id string, params map[string]any) any {
			proposal := agentToolsNativeProposal(params["proposal"])
			receipt := input.Supervisor.Propose(proposal, agentToolsString(params["requestId"]), params["newVersion"] == true)
			return agentToolsText(stringifyJSON(receipt))
		},
		"confirm_draft": func(id string, params map[string]any) any {
			instruction := strings.TrimSpace(agentToolsStringOrEmpty(params["instruction"]))
			if instruction == "" {
				Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
			}
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			revision, _ := agentToolsNumberValue(params["draftRevision"])
			receipt := input.Supervisor.ConfirmDraft(PiAdapterConfirmDraft{
				ProposalVersion: int(version), DraftRevision: int(revision),
				TargetBranch: agentToolsStringOrEmpty(params["targetBranch"]), Instruction: instruction,
				RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
	}
}
