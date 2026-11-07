package graph

import "fmt"

func (s *TaskStore) SetNodeStatus(taskID, nodeID, status string) {
	kernelExec(s.DB, "UPDATE nodes SET status=? WHERE task_id=? AND id=?", status, taskID, nodeID)
}

func (s *TaskStore) SetNodePending(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "pending")
}

func (s *TaskStore) SetNodePreparing(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "preparing")
}

func (s *TaskStore) SetNodeRunning(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "running")
}

func (s *TaskStore) SetNodeBlocked(taskID, nodeID string) {
	s.SetNodeStatus(taskID, nodeID, "blocked")
}

func (s *TaskStore) ResumeSucceededNode(taskID, nodeID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=? AND status='succeeded'", taskID, nodeID)
}

func (s *TaskStore) SetNodeRunningForActivation(taskID, nodeID, activationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='running' WHERE task_id=? AND id=? AND activation_id=?", taskID, nodeID, activationID)
}

func (s *TaskStore) SetNodeSpec(taskID, nodeID, spec string) {
	kernelExec(s.DB, "UPDATE nodes SET spec=? WHERE task_id=? AND id=?", spec, taskID, nodeID)
}

func (s *TaskStore) SetNodeActivation(taskID, nodeID, activationID string) {
	kernelExec(s.DB, "UPDATE nodes SET activation_id=? WHERE task_id=? AND id=?", activationID, taskID, nodeID)
}

func (s *TaskStore) CreateNode(taskID, nodeID, spec, instanceID string) {
	kernelExec(s.DB, "INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)", taskID, nodeID, spec, instanceID)
}

func (s *TaskStore) RetryNodeOutput(taskID, nodeID, output, operationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status='pending',output=?,stall_count=stall_count+1,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?",
		output, operationID, taskID, nodeID)
}

func (s *TaskStore) SettleNodeOutput(taskID, nodeID, status, output, operationID string) {
	kernelExec(s.DB, "UPDATE nodes SET status=?,output=?,route=NULL,output_version=output_version+1,output_operation=? WHERE task_id=? AND id=?",
		status, output, operationID, taskID, nodeID)
}

const nodeTerminalStatuses = "('succeeded','skipped','retired','failed')"

func (s *TaskStore) OpenNodePause(taskID string, at int64) {
	kernelExec(s.DB, fmt.Sprintf("UPDATE nodes SET pause_since=? WHERE task_id=? AND pause_since IS NULL AND status NOT IN %s", nodeTerminalStatuses), at, taskID)
}

func (s *TaskStore) CloseNodePause(taskID string, at int64) {
	kernelExec(s.DB, `UPDATE nodes SET pause_ms=COALESCE(pause_ms,0)+(?-pause_since), pause_since=NULL
    WHERE task_id=? AND pause_since IS NOT NULL AND ? >= pause_since`, at, taskID, at)
}

func (s *TaskStore) OpenNodeUserWait(taskID, nodeID string, at int64) {
	kernelExec(s.DB, "UPDATE nodes SET user_wait_since=? WHERE task_id=? AND id=? AND user_wait_since IS NULL", at, taskID, nodeID)
}

func (s *TaskStore) CloseNodeUserWait(taskID, nodeID string, at int64) {
	kernelExec(s.DB, `UPDATE nodes SET user_wait_ms=COALESCE(user_wait_ms,0)+(?-user_wait_since), user_wait_since=NULL
    WHERE task_id=? AND id=? AND user_wait_since IS NOT NULL AND ? >= user_wait_since`, at, taskID, nodeID, at)
}
