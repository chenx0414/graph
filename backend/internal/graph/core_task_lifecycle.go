package graph

func (s *TaskStore) SetTaskPhase(taskID, phase string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=?", phase, taskID)
}

func (s *TaskStore) StartTaskPhase(taskID, phase, from string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=? AND phase=?", phase, taskID, from)
}

func (s *TaskStore) ResumeTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=0,phase='running' WHERE id=?", taskID)
}

func (s *TaskStore) PauseTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1 WHERE id=?", taskID)
}

func (s *TaskStore) BlockTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1,phase='blocked' WHERE id=?", taskID)
}

func (s *TaskStore) SetTaskPaused(taskID string, paused bool) {
	if paused {
		kernelExec(s.Db, "DELETE FROM project_archive_pauses WHERE task_id=?", taskID)
	} else if kernelRow(s.Db, `SELECT t.id FROM tasks t
 LEFT JOIN work_graphs g ON g.graph_id=t.id LEFT JOIN work_requests w ON w.id=g.work_id
 LEFT JOIN projects project ON project.id=t.project_id
 WHERE t.id=? AND t.phase!='chatting' AND (project.archived_at IS NOT NULL OR w.execution_paused=1)`, taskID) != nil {
		Raise("paused", "Restore the project and resume its work before resuming this graph")
	} else {
		kernelExec(s.Db, "DELETE FROM project_archive_pauses WHERE task_id=?", taskID)
	}
	kernelExec(s.Db, "DELETE FROM graph_preparation_pauses WHERE task_id=?", taskID)
	flag := 0
	if paused {
		flag = 1
	}
	kernelExec(s.DB, "UPDATE tasks SET paused=? WHERE id=?", flag, taskID)
}

func (s *TaskStore) StopTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='stopping',paused=0 WHERE id=?", taskID)
}

func (s *TaskStore) AbandonTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='abandoned' WHERE id=?", taskID)
}

func (s *TaskStore) ParkStalledTask(taskID string) bool {
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_queue'"); !ok {
		return false
	}
	if kernelRow(s.DB, `SELECT id FROM tasks WHERE id=? AND phase IN ('running','idle')`, taskID) == nil {
		return false
	}
	if kernelRow(s.DB, `SELECT 1 FROM kernel_queue WHERE task_id=? AND state='claimed' LIMIT 1`, taskID) != nil {
		return false
	}
	queued := `SELECT 1 FROM kernel_queue WHERE task_id=? AND state='queued' LIMIT 1`
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_node_state'"); ok {
		queued = `SELECT 1 FROM kernel_queue q WHERE q.task_id=? AND q.state='queued' AND COALESCE((SELECT paused FROM kernel_node_state st WHERE st.task_id=q.task_id AND st.node_id=q.node_id), 0)=0 LIMIT 1`
	}
	if kernelRow(s.DB, queued, taskID) != nil {
		return false
	}
	if kernelRow(s.DB, `SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running' LIMIT 1`, taskID) != nil {
		return false
	}
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_module_inbox'"); ok {
		if kernelRow(s.DB, `SELECT 1 FROM kernel_module_inbox i WHERE i.task_id=? AND i.processed=0 AND COALESCE((SELECT paused FROM kernel_node_state st WHERE st.task_id=i.task_id AND st.node_id=i.module_id), 0)=0 LIMIT 1`, taskID) != nil {
			return false
		}
	}
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_module_operations'"); ok {
		if kernelRow(s.DB, `SELECT 1 FROM kernel_module_operations WHERE task_id=? AND state IN ('prepared','dispatched') LIMIT 1`, taskID) != nil {
			return false
		}
	}
	stopped := kernelRow(s.DB, `SELECT 1 FROM kernel_nodes WHERE task_id=? AND status IN ('blocked','failed') LIMIT 1`, taskID) != nil ||
		kernelRow(s.DB, `SELECT 1 FROM kernel_queue WHERE task_id=? AND state IN ('failed','queued') LIMIT 1`, taskID) != nil ||
		kernelRow(s.DB, `SELECT 1 FROM questions WHERE task_id=? AND status='open' LIMIT 1`, taskID) != nil
	if !stopped {
		if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_module_operations'"); ok {
			stopped = kernelRow(s.DB, `SELECT 1 FROM kernel_module_operations WHERE task_id=? AND state IN ('failed','uncertain') LIMIT 1`, taskID) != nil
		}
	}
	if !stopped {
		if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_module_inbox'"); ok {
			stopped = kernelRow(s.DB, `SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0 LIMIT 1`, taskID) != nil
		}
	}
	if !stopped {
		return false
	}
	s.BlockTaskPhase(taskID)
	s.Event(taskID, "graph.stalled", map[string]any{"reason": "No work is left and a node is blocked or failed"})
	return true
}

func (s *TaskStore) ParkStalledTasks() []string {
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_queue'"); !ok {
		return nil
	}
	parked := []string{}
	for _, row := range kernelRows(s.DB, `SELECT id FROM tasks WHERE phase IN ('running','idle') ORDER BY rowid`) {
		taskID := kernelString(row["id"])
		if s.ParkStalledTask(taskID) {
			parked = append(parked, taskID)
		}
	}
	return parked
}

func (s *TaskStore) SettleDrainedPhase(taskID string) string {
	if s.ParkStalledTask(taskID) {
		return "blocked"
	}
	s.StartTaskPhase(taskID, "idle", "running")
	return "idle"
}

func (s *TaskStore) BlockTaskPhase(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='blocked' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskID)
}

func (s *TaskStore) CompleteTaskPhase(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='completing' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskID)
}

func (s *TaskStore) CompleteBlockedTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='completing' WHERE id=? AND phase='blocked' AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)", taskID, taskID)
}

func (s *TaskStore) BumpRequirementVersion(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", taskID)
}

func (s *TaskStore) AcceptProposal(taskID string, proposal int, targetBranch, phase string) {
	kernelExec(s.DB, "UPDATE tasks SET accepted_proposal=?,target_branch=?,phase=?,graph_version=1 WHERE id=?",
		proposal, targetBranch, phase, taskID)
}

func (s *TaskStore) SetTaskProject(taskID, projectID string) {
	kernelExec(s.DB, "UPDATE tasks SET project_id=? WHERE id=?", projectID, taskID)
}

func (s *TaskStore) SetTaskLatestProposal(taskID string, proposal int) {
	kernelExec(s.DB, "UPDATE tasks SET latest_proposal=? WHERE id=?", proposal, taskID)
}

func (s *TaskStore) SetTaskIntegration(taskID, branch, integrationSha, targetSha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_branch=?,integration_sha=?,target_sha=? WHERE id=?", branch, integrationSha, targetSha, taskID)
}

func (s *TaskStore) SetTaskIntegrationSha(taskID, sha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_sha=? WHERE id=?", sha, taskID)
}

func (s *TaskStore) SetTaskTargetSha(taskID, sha string) {
	kernelExec(s.DB, "UPDATE tasks SET target_sha=? WHERE id=?", sha, taskID)
}

func (s *TaskStore) SetTaskIntegrationAndTarget(taskID, integrationSha, targetSha string) {
	kernelExec(s.DB, "UPDATE tasks SET integration_sha=?,target_sha=? WHERE id=?", integrationSha, targetSha, taskID)
}

func (s *TaskStore) CreateGraphTask(id, projectID, request string, createdSeq int64) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)", id, projectID, request, 1, 0, createdSeq, "running")
}

func (s *TaskStore) CreateSubgraphTask(id, projectID string, conversationID any, request string, createdSeq int64, targetBranch any) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase,target_branch) VALUES(?,?,?,?,1,0,?,?,?)",
		id, projectID, conversationID, request, createdSeq, "running", targetBranch)
}

func (s *TaskStore) CreateMasterTask(id, projectID, request string, createdSeq int64) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)", id, projectID, request, createdSeq)
}

func (s *TaskStore) CreateConversationTask(id, projectID, request, phase string, createdSeq int64, conversationID string) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,1,?,?,?)",
		id, projectID, request, phase, createdSeq, conversationID)
}

func (s *TaskStore) CreateConfirmedTask(id, projectID, request string, requirementVersion int64, targetBranch any, phase string, createdSeq int64, conversationID any, decisionDigest any) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,conversation_id,decision_digest) VALUES(?,?,?,?,1,1,?,?,?,1,?,?)",
		id, projectID, request, requirementVersion, targetBranch, phase, createdSeq, conversationID, decisionDigest)
}

func (s *TaskStore) PauseProjectTasks(projectID string) {
	kernelExec(s.Db, `INSERT OR IGNORE INTO project_archive_pauses(task_id)
 SELECT id FROM tasks WHERE project_id=? AND (paused=0 OR EXISTS(SELECT 1 FROM graph_preparation_pauses p WHERE p.task_id=tasks.id))
 AND phase NOT IN ('chatting','completed','stopping','stopped','abandoned')`, projectID)
	kernelExec(s.Db, "UPDATE tasks SET paused=1 WHERE project_id=? AND phase NOT IN ('chatting','completed','stopped','abandoned')", projectID)
}

func (s *TaskStore) ArchivePausedWorkGraphs(workID string) []string {
	ids := []string{}
	for _, row := range kernelRows(s.Db, `SELECT t.id FROM project_archive_pauses p JOIN tasks t ON t.id=p.task_id
 JOIN work_graphs g ON g.graph_id=t.id WHERE g.work_id=? AND g.state='ready'
 AND t.phase NOT IN ('completed','stopping','stopped','abandoned','blocked')`, workID) {
		ids = append(ids, kernelString(row["id"]))
	}
	return ids
}

func (s *TaskStore) ClearArchivePause(taskID string) {
	kernelExec(s.Db, "DELETE FROM project_archive_pauses WHERE task_id=?", taskID)
}

func (s *TaskStore) StartGraphPreparation(taskID string) {
	kernelExec(s.Db, "INSERT INTO graph_preparation_pauses(task_id) VALUES(?)", taskID)
	s.PauseTask(taskID)
}

func (s *TaskStore) FinishGraphPreparation(taskID string, mayResume bool) bool {
	preparing := kernelRow(s.Db, "SELECT task_id FROM graph_preparation_pauses WHERE task_id=?", taskID) != nil
	kernelExec(s.Db, "DELETE FROM graph_preparation_pauses WHERE task_id=?", taskID)
	if preparing && mayResume {
		s.ClearArchivePause(taskID)
		s.ResumeTask(taskID)
		return true
	}
	return false
}
