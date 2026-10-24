package graph

import "fmt"

// The nodes table is the v1 node table: one row per node of a task, with
// the node's spec, the instance it runs in, its activation, its status and
// its output.
//
// It was written from seventeen files with SQL of their own, so the shape
// of the table was known in seventeen places. The task store owns it now,
// the way it owns the tasks, questions and invocations tables.
//
// The status vocabulary lives here too, the way the task's phase
// vocabulary lives in core_task_lifecycle.go: the callers say which state
// a node reaches, and this file is the only place that spells it.

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
