package graph

import (
	"strings"
)

// agentToolsGraphHandlers are the handlers of the Graph tools.
func agentToolsGraphHandlers(input AgentToolsInput, root string, readRoots []string, hostRead bool, hostWrite bool, pathOptions BoundedPathOptions, artifacts agentToolsArtifacts, peers *agentToolsPeers) map[string]func(id string, params map[string]any) any {
	return map[string]func(id string, params map[string]any) any{
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
		"withdraw_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			reason := agentToolsStringOrEmpty(params["reason"])
			receipt := input.Supervisor.WithdrawDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), Reason: &reason, RequestId: agentToolsString(params["requestId"]),
			})
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
		"archive_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.ArchiveDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"restore_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.RestoreDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
		"delete_draft": func(id string, params map[string]any) any {
			version, _ := agentToolsNumberValue(params["proposalVersion"])
			receipt := input.Supervisor.DeleteDraft(PiAdapterDraftAction{
				ProposalVersion: int(version), RequestId: agentToolsString(params["requestId"]),
			})
			return agentToolsText(stringifyJSON(receipt))
		},
	}
}
