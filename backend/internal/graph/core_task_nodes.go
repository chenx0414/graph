package graph

import "fmt"

// SetNodeStatus sets the status of one node.
func (s *TaskStore) SetNodeStatus(taskID, nodeID, status string) {
	kernelExec(s.DB, "UPDATE nodes SET status=? WHERE task_id=? AND id=?", status, taskID, nodeID)
}

// SetNodePending says a node is waiting to run.
func (s *TaskStore) SetNodePending(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "pending")
}

// SetNodePreparing says a node is being prepared for its turn.
func (s *TaskStore) SetNodePreparing(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "preparing")
}

// SetNodeRunning says a node is running.
func (s *TaskStore) SetNodeRunning(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "running")
}

// SetNodeBlocked says a node cannot run until something changes.
func (s *TaskStore) SetNodeBlocked(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "blocked")
}

// ResumeSucceededNode puts a node that had finished back in the queue.
//
// The status only changes when the node really had finished, so a node
// that is running or blocked is left alone.
func (s *TaskStore) ResumeSucceededNode(taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'", taskID, nodeID)
}

// SetNodeRunningForActivation says a node is running the turn of one
// activation. The activation has to match, so a turn that was admitted
// for another activation does not claim this node.
func (s *TaskStore) SetNodeRunningForActivation(taskID, nodeID, activationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='running' WHERE task_id=? AND id=? AND activation_id=?", taskID, nodeID, activationID)
}

// SetNodeSpec records the spec a node runs with.
func (s *TaskStore) SetNodeSpec(taskID, nodeID, spec string) {
	kernelExec(s.DB, "UPDATE nodes SET spec=? WHERE task_id=? AND id=?", spec, taskID, nodeID)
}

// SetNodeActivation says a node runs the turn of one activation.
func (s *TaskStore) SetNodeActivation(taskID, nodeID, activationID string) {
	kernelExec(s.DB, "UPDATE nodes SET activation_id=? WHERE task_id=? AND id=?", activationID, taskID, nodeID)
}

// CreateNode adds one node to a task.
func (s *TaskStore) CreateNode(taskID, nodeID, spec, instanceID string) {
	kernelExec(s.DB, "INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)", taskID, nodeID, spec, instanceID)
}

// RetryNodeOutput records the output of an attempt that will be tried
// again. The node's stall count goes up, so the retry budget sees it.
func (s *TaskStore) RetryNodeOutput(taskID, nodeID, output, operationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='pending',output=?,stall_count=stall_count+1,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?",
		output, operationID, taskID, nodeID)
}

// SettleNodeOutput records the output of a turn that ended, and the state
// the node is left in. The node's route is cleared, because the output it
// was waiting for has arrived.
func (s *TaskStore) SettleNodeOutput(taskID, nodeID, status, output, operationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status=?,output=?,route=NULL,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?",
		status, output, operationID, taskID, nodeID)
}

// nodeTerminalStatuses are the states a node never comes back from by
// itself: once it is one of these, its pause clock stops.
const nodeTerminalStatuses = "('succeeded','skipped','retired','failed')"

// OpenNodePause starts the pause clock of the nodes of a task.
func (s *TaskStore) OpenNodePause(taskID string, at int64) {
	kernelExec(s.DB, fmt.Sprintf("UPDATE nodes SET pause_since=? WHERE task_id=? AND pause_since IS NULL AND status NOT IN %s", nodeTerminalStatuses), at, taskID)
}

// CloseNodePause stops the pause clock of the nodes of a task, and keeps
// the time they spent paused.
func (s *TaskStore) CloseNodePause(taskID string, at int64) {
	kernelExec(s.DB, `UPDATE nodes SET pause_ms=COALESCE(pause_ms,0)+(?-pause_since), pause_since=NULL
    WHERE task_id=? AND pause_since IS NOT NULL AND ? >= pause_since`, at, taskID, at)
}

// OpenNodeUserWait starts the clock of the time one node waited for the
// user.
func (s *TaskStore) OpenNodeUserWait(taskID, nodeID string, at int64) {
	kernelExec(s.DB, "UPDATE nodes SET user_wait_since=? WHERE task_id=? AND id=? AND user_wait_since IS NULL", at, taskID, nodeID)
}

// CloseNodeUserWait stops the clock of the time one node waited for the
// user, and keeps the time it waited.
func (s *TaskStore) CloseNodeUserWait(taskID, nodeID string, at int64) {
	kernelExec(s.DB, `UPDATE nodes SET user_wait_ms=COALESCE(user_wait_ms,0)+(?-user_wait_since), user_wait_since=NULL
    WHERE task_id=? AND id=? AND user_wait_since IS NOT NULL AND ? >= user_wait_since`, at, taskID, nodeID, at)
}
