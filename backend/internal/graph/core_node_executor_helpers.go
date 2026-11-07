package graph

import (
	"fmt"
	"regexp"
)

type nodeBlocked struct{}

func (nodeBlocked) Error() string { return "blocked" }

type DeliverableSettlement struct {
	Ok     bool
	Reason string
}

func (e *NodeExecutor) settleDeliverable(executionId, nodeId string) DeliverableSettlement {
	var workspace *string
	if e.options.Workspace != nil {
		workspace = e.options.Workspace()
	}
	var artifacts *ArtifactWorkspace
	if e.options.Artifacts != nil {
		artifacts = e.options.Artifacts()
	}
	if workspace == nil || *workspace == "" || artifacts == nil {
		return DeliverableSettlement{Ok: true}
	}
	execution := e.kernel.Execution(executionId)
	if execution == nil {
		return DeliverableSettlement{Ok: true}
	}
	outcome := SettleDeliverable(SettleDeliverableInput{
		Kernel: e.kernel, Artifacts: artifacts, GraphId: e.graphId, NodeId: nodeId,
		RevisionVersion: execution.RevisionVersion, ExecutionId: executionId, Workspace: *workspace,
	})
	if !outcome.Ok {
		return DeliverableSettlement{Ok: false, Reason: outcome.Reason}
	}
	return DeliverableSettlement{Ok: true}
}

func (e *NodeExecutor) fail(executionId, nodeId string, seq int64, reason string) NodeOutcome {
	e.kernel.FinishExecution(executionId, "failed")
	e.kernel.NoteQueueFailure(e.graphId, seq, reason)
	e.kernel.FailNode(e.graphId, nodeId, reason)
	e.queue.Complete(seq, QueueCompletion{Kind: "failed", Reason: reason})
	return NodeOutcomeFailed
}

func mustRow(row map[string]any, ok bool) map[string]any {
	if !ok {
		panic(fmt.Errorf("expected row"))
	}
	return row
}

func panicMessage(value any) string {
	switch err := value.(type) {
	case error:
		return err.Error()
	default:
		return fmt.Sprint(value)
	}
}

var tokenBudgetExhausted = regexp.MustCompile(`Token budget exhausted`)

var pausedReport = regexp.MustCompile(`(?i)paused`)

var terminalReport = regexp.MustCompile(`(?i)budget|permission|paused|credential unavailable|cannot be hosted`)

func nodeBudget(definition GraphDefinition, nodeId string) *NodeBudget {
	if node := definition.Nodes[nodeId]; node.Budget != nil {
		return node.Budget
	}
	if definition.Defaults != nil {
		return definition.Defaults.Budget
	}
	return nil
}

func nodeRetry(definition GraphDefinition, nodeId string) *NodeRetry {
	if node, ok := definition.Nodes[nodeId]; ok && node.Retry != nil {
		return node.Retry
	}
	return nil
}
