package graph

import "github.com/chenx0414/graph/backend/internal/pigkernel"

func agentInspectFromPig(view pigkernel.SessionInspect) AgentSessionInspect {
	return AgentSessionInspect{
		SessionId:        view.SessionId,
		SessionFile:      view.SessionFile,
		ActiveTools:      view.ActiveTools,
		RegisteredTools:  view.RegisteredTools,
		LoadedExtensions: view.LoadedExtensions,
		Messages:         view.Messages,
	}
}

func agentTurnFromPig(turn pigkernel.SessionTurn, inspect AgentSessionInspect) AgentSessionTurn {
	result := AgentSessionTurn{Inspect: inspect, FinalAssistantText: turn.Text}
	if turn.StopReason != "" {
		result.StopReason = stringPointer(turn.StopReason)
	}
	if turn.ErrorMessage != "" {
		result.ErrorMessage = stringPointer(turn.ErrorMessage)
	}
	if turn.Usage != nil {
		result.Usage = &AgentSessionUsage{
			Input: turn.Usage.Input, Output: turn.Usage.Output,
			CacheRead: turn.Usage.CacheRead, CacheWrite: turn.Usage.CacheWrite,
			Total: turn.Usage.Total,
		}
	}
	return result
}
