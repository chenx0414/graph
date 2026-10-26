package graph

// SetTaskPhase sets the phase of a task.
func (s *TaskStore) SetTaskPhase(taskID, phase string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=?", phase, taskID)
}

// StartTaskPhase moves a task into a phase, and only from the phase it is
// expected to be in.
func (s *TaskStore) StartTaskPhase(taskID, phase, from string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=? AND phase=?", phase, taskID, from)
}

// ResumeTask puts a task back to running and unpauses it.
func (s *TaskStore) ResumeTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=0,phase='running' WHERE id=?", taskID)
}

// PauseTask pauses a task without ending it.
func (s *TaskStore) PauseTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1 WHERE id=?", taskID)
}

// BlockTask pauses a task and parks it.
func (s *TaskStore) BlockTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1,phase='blocked' WHERE id=?", taskID)
}

// SetTaskPaused pauses or resumes a task.
func (s *TaskStore) SetTaskPaused(taskID string, paused bool) {
	flag := 0
	if paused {
		flag = 1
	}
	kernelExec(s.DB, "UPDATE tasks SET paused=? WHERE id=?", flag, taskID)
}

// StopTask begins stopping a task.
func (s *TaskStore) StopTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='stopping',paused=0 WHERE id=?", taskID)
}

// AbandonTask gives a task up.
func (s *TaskStore) AbandonTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='abandoned' WHERE id=?", taskID)
}

// BlockTaskPhase parks a task that is not already closing.
func (s *TaskStore) BlockTaskPhase(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskID)
}

// CompleteTaskPhase begins completing a task that is not already closing.
func (s *TaskStore) CompleteTaskPhase(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='completing' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskID)
}

// CompleteBlockedTask begins completing a task that asked to be completed.
func (s *TaskStore) CompleteBlockedTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)", taskID, taskID)
}

// BumpRequirementVersion records that a task's requirement moved on.
func (s *TaskStore) BumpRequirementVersion(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", taskID)
}

// AcceptProposal records the proposal a task accepted, the branch it will
// deliver to and the phase it is in.
func (s *TaskStore) AcceptProposal(taskID string, proposal int, targetBranch, phase string) {
	kernelExec(s.DB, "UPDATE tasks SET accepted_proposal=?,target_branch=?,phase=?,graph_version=1 WHERE id=?",
		proposal, targetBranch, phase, taskID)
}

// SetTaskProject records the project a task belongs to.
func (s *TaskStore) SetTaskProject(taskID, projectID string) {
	kernelExec(s.DB, "UPDATE tasks SET project_id=? WHERE id=?", projectID, taskID)
}

// SetTaskLatestProposal records the newest proposal a task has.
func (s *TaskStore) SetTaskLatestProposal(taskID string, proposal int) {
	kernelExec(s.DB, "UPDATE tasks SET latest_proposal=? WHERE id=?", proposal, taskID)
}

// SetTaskIntegration records the integration branch a task delivers to and
// the commits it integrates.
func (s *TaskStore) SetTaskIntegration(taskID, branch, integrationSha, targetSha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_branch=?,integration_sha=?,target_sha=? WHERE id=?", branch, integrationSha, targetSha, taskID)
}

// SetTaskIntegrationSha records the commit a task has integrated.
func (s *TaskStore) SetTaskIntegrationSha(taskID, sha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_sha=? WHERE id=?", sha, taskID)
}

// SetTaskTargetSha records the commit a task is delivered at.
func (s *TaskStore) SetTaskTargetSha(taskID, sha string) {
	kernelExec(s.DB, "UPDATE tasks SET target_sha=? WHERE id=?", sha, taskID)
}

// SetTaskIntegrationAndTarget records the commits a task has integrated and
// the one it is delivered at.
func (s *TaskStore) SetTaskIntegrationAndTarget(taskID, integrationSha, targetSha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_sha=?,target_sha=? WHERE id=?", integrationSha, targetSha, taskID)
}

// CreateGraphTask creates the task of a new graph.
func (s *TaskStore) CreateGraphTask(id, projectID, request string, createdSeq int64) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)", id, projectID, request, 1, 0, createdSeq, "running")
}

// CreateSubgraphTask creates the task of a graph under a conversation.
func (s *TaskStore) CreateSubgraphTask(id, projectID string, conversationID any, request string, createdSeq int64, targetBranch any) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase,target_branch) VALUES(?,?,?,?,1,0,?,?,?)",
		id, projectID, conversationID, request, createdSeq, "running", targetBranch)
}

// CreateMasterTask creates the task of one master turn.
func (s *TaskStore) CreateMasterTask(id, projectID, request string, createdSeq int64) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)", id, projectID, request, createdSeq)
}

// CreateConversationTask creates the task a conversation is anchored to.
func (s *TaskStore) CreateConversationTask(id, projectID, request, phase string, createdSeq int64, conversationID string) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,1,?,?,?)",
		id, projectID, request, phase, createdSeq, conversationID)
}

// CreateConfirmedTask creates the task of a confirmed proposal.
//
// The first proposal of a task is the one that is accepted, so the latest
// and the accepted proposal are both the first.
func (s *TaskStore) CreateConfirmedTask(id, projectID, request string, requirementVersion int64, targetBranch any, phase string, createdSeq int64, conversationID any, decisionDigest any) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,conversation_id,decision_digest) VALUES(?,?,?,?,1,1,?,?,?,1,?,?)",
		id, projectID, request, requirementVersion, targetBranch, phase, createdSeq, conversationID, decisionDigest)
}
