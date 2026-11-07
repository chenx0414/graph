package graph

import "fmt"

const DEFAULT_RETRIES = 2

const DEFAULT_RESUBMITS = 1

type QueueInput struct {
	NodeId   string
	Kind     string
	Text     *string
	Input    *string
	Value    Json
	HasValue bool
}

type RetryBudget struct {
	Attempts         int `json:"attempts"`
	RetriesAllowed   int `json:"retriesAllowed"`
	ResubmitsAllowed int `json:"resubmitsAllowed"`
	ResubmitsUsed    int `json:"resubmitsUsed"`
}

type QueueCompletion struct {
	Kind   string
	Reason string
}

type NodeRetryConfig struct {
	RetriesAllowed   *int
	ResubmitsAllowed *int
}

type NodeQueueDefaults struct {
	DefaultRetries   *int
	DefaultResubmits *int
}

type NodeQueue struct {
	kernel   *KernelStore
	taskId   string
	defaults NodeQueueDefaults
}

func NewNodeQueue(kernel *KernelStore, taskId string, defaults ...NodeQueueDefaults) *NodeQueue {
	queue := &NodeQueue{kernel: kernel, taskId: taskId}
	if len(defaults) > 0 {
		queue.defaults = defaults[0]
	}
	return queue
}

func queueText(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (q *NodeQueue) Enqueue(input QueueInput) QueueRow {
	var payload any
	switch input.Kind {
	case "chat":
		payload = map[string]any{"text": queueText(input.Text)}
	case "control":
		value := input.Value
		if !input.HasValue {
			value = nil
		}
		payload = map[string]any{"action": queueText(input.Text), "value": value}
	default:
		value := input.Value
		if !input.HasValue {
			value = nil
		}
		payload = map[string]any{"input": queueText(input.Input), "value": value}
	}
	return q.kernel.Enqueue(q.taskId, QueueInsert{NodeId: input.NodeId, Kind: input.Kind, Payload: payload})
}

func (q *NodeQueue) Next(nodeId string) *QueueRow {
	if q.Paused(nodeId) {
		return nil
	}
	return q.kernel.NextQueued(q.taskId, nodeId)
}

func (q *NodeQueue) Claim(nodeId string) *QueueRow {
	if q.Paused(nodeId) {
		return nil
	}
	if _, busy := graphDBRow(q.kernel.Store.Db, "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed' LIMIT 1", q.taskId, nodeId); busy {
		return nil
	}
	next := q.kernel.NextQueued(q.taskId, nodeId)
	if next == nil {
		return nil
	}
	claimed := q.kernel.ClaimQueued(q.taskId, next.Seq)
	q.kernel.Store.StartTaskPhase(q.taskId, "running", "blocked")
	return claimed
}

func (q *NodeQueue) Complete(seq int64, outcome QueueCompletion) {
	nodeRow, ok := graphDBRow(q.kernel.Store.Db, "SELECT node_id FROM kernel_queue WHERE task_id=? AND seq=?", q.taskId, seq)
	if !ok {
		Raise("invalid_queue", fmt.Sprintf("Unknown queue item %d", seq))
	}
	switch outcome.Kind {
	case "submitted":
		q.kernel.FinishQueued(q.taskId, seq, "done")
		q.kernel.Store.ParkStalledTask(q.taskId)
		return
	case "blocked":
		q.kernel.BlockQueued(q.taskId, seq)
		q.kernel.Store.ParkStalledTask(q.taskId)
		return
	}
	q.kernel.FinishQueued(q.taskId, seq, "failed")
	q.kernel.SetNodeQueuePaused(q.taskId, graphDBString(nodeRow, "node_id"), true)
	q.kernel.Store.ParkStalledTask(q.taskId)
}

func (q *NodeQueue) Paused(nodeId string) bool {
	return q.kernel.NodeState(q.taskId, nodeId).Paused
}

func (q *NodeQueue) Resume(nodeId string) {
	q.kernel.SetNodeQueuePaused(q.taskId, nodeId, false)
}

func (q *NodeQueue) RetryBudget(nodeId string) RetryBudget {
	state := q.kernel.NodeState(q.taskId, nodeId)
	retries := DEFAULT_RETRIES
	if state.RetriesAllowed != nil {
		retries = *state.RetriesAllowed
	} else if q.defaults.DefaultRetries != nil {
		retries = *q.defaults.DefaultRetries
	}
	resubmits := DEFAULT_RESUBMITS
	if state.ResubmitsAllowed != nil {
		resubmits = *state.ResubmitsAllowed
	} else if q.defaults.DefaultResubmits != nil {
		resubmits = *q.defaults.DefaultResubmits
	}
	return RetryBudget{Attempts: state.Attempts, RetriesAllowed: retries, ResubmitsAllowed: resubmits, ResubmitsUsed: state.ResubmitsUsed}
}

func (q *NodeQueue) NoteAttempt(nodeId string) {
	q.kernel.NoteNodeAttempt(q.taskId, nodeId)
}

func (q *NodeQueue) NoteResubmit(nodeId string) {
	q.kernel.NoteNodeResubmit(q.taskId, nodeId, q.RetryBudget(nodeId).ResubmitsAllowed)
}

func (q *NodeQueue) Configure(nodeId string, config NodeRetryConfig) {
	q.kernel.ConfigureNodeRetries(q.taskId, nodeId, config)
}
