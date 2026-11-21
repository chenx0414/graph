package graph

import (
	"database/sql"
	"errors"
)

func (s *TaskStore) SetTaskPhase(taskID, phase string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=?", phase, taskID)
}

func (s *TaskStore) StartTaskPhase(taskID, phase, from string) {
	kernelExec(s.DB, "UPDATE tasks SET phase=? WHERE id=? AND phase=?", phase, taskID, from)
}

func (s *TaskStore) ResumeTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=0,phase='"+string(PhaseRunning)+"' WHERE id=? AND "+taskPhaseNotIn("phase", taskPhaseFinishedList()...), taskID)
}

func (s *TaskStore) PauseTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1 WHERE id=?", taskID)
}

func (s *TaskStore) BlockTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET paused=1,phase='"+string(PhaseBlocked)+"' WHERE id=? AND "+taskPhaseNotIn("phase", taskPhaseHaltingList()...), taskID)
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
	kernelExec(s.DB, "UPDATE tasks SET phase='"+string(PhaseStopping)+"',paused=0 WHERE id=? AND "+taskPhaseNotIn("phase", taskPhaseHaltingList()...), taskID)
}

func (s *TaskStore) AbandonTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='"+string(PhaseAbandoned)+"' WHERE id=? AND "+taskPhaseNotIn("phase", PhaseCompleted, PhaseStopped), taskID)
}

func (s *TaskStore) ParkStalledTask(taskID string) bool {
	if _, ok := g5One(s.DB, "SELECT 1 FROM sqlite_master WHERE type='table' AND name='kernel_queue'"); !ok {
		return false
	}
	if kernelRow(s.DB, `SELECT id FROM tasks WHERE id=? AND `+taskPhaseIn("phase", taskPhaseParkableList()...), taskID) == nil {
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
	for _, row := range kernelRows(s.DB, `SELECT id FROM tasks WHERE `+taskPhaseIn("phase", taskPhaseParkableList()...)+` ORDER BY rowid`) {
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
	kernelExec(s.DB, "UPDATE tasks SET phase='"+string(PhaseBlocked)+"' WHERE id=? AND "+taskPhaseNotIn("phase", taskPhaseHaltingList()...), taskID)
}

func (s *TaskStore) CompleteTaskPhase(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='"+string(PhaseCompleting)+"' WHERE id=? AND "+taskPhaseNotIn("phase", taskPhaseHaltingList()...), taskID)
}

func (s *TaskStore) CompleteBlockedTask(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET phase='"+string(PhaseCompleting)+"' WHERE id=? AND "+taskPhaseIn("phase", PhaseBlocked)+" AND EXISTS(SELECT 1 FROM kernel_lifecycle WHERE task_id=? AND completion_requested=1)", taskID, taskID)
}

func (s *TaskStore) BumpRequirementVersion(taskID string) {
	kernelExec(s.DB, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", taskID)
}

func (s *TaskStore) AcceptProposal(taskID string, proposal int, targetBranch, phase string) {
	requireTaskPhase(phase)
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
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES(?,?,?,?,?,?,?)", id, projectID, request, 1, 0, createdSeq, string(PhaseRunning))
}

func (s *TaskStore) CreateSubgraphTask(id, projectID string, conversationID any, request string, createdSeq int64, targetBranch any) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase,target_branch) VALUES(?,?,?,?,1,0,?,?,?)",
		id, projectID, conversationID, request, createdSeq, string(PhaseRunning), targetBranch)
}

func (s *TaskStore) CreateMasterTask(id, projectID, request string, createdSeq int64) {
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)", id, projectID, request, createdSeq)
}

func (s *TaskStore) CreateConversationTask(id, projectID, request, phase string, createdSeq int64, conversationID string) {
	requireTaskPhase(phase)
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,1,?,?,?)",
		id, projectID, request, phase, createdSeq, conversationID)
}

func (s *TaskStore) CreateConfirmedTask(id, projectID, request string, requirementVersion int64, targetBranch any, phase string, createdSeq int64, conversationID any, decisionDigest any) {
	requireTaskPhase(phase)
	kernelExec(s.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,conversation_id,decision_digest) VALUES(?,?,?,?,1,1,?,?,?,1,?,?)",
		id, projectID, request, requirementVersion, targetBranch, phase, createdSeq, conversationID, decisionDigest)
}

func (s *TaskStore) PauseProjectTasks(projectID string) {
	kernelExec(s.Db, `INSERT OR IGNORE INTO project_archive_pauses(task_id)
 SELECT id FROM tasks WHERE project_id=? AND (paused=0 OR EXISTS(SELECT 1 FROM graph_preparation_pauses p WHERE p.task_id=tasks.id))
 AND `+taskPhaseIn("phase", taskPhasePausedOnArchiveList()...), projectID)
	kernelExec(s.Db, "UPDATE tasks SET paused=1 WHERE project_id=? AND "+taskPhaseIn("phase", taskPhasePausedOnArchiveList()...), projectID)
}

func (s *TaskStore) ArchivePausedWorkGraphs(workID string) []string {
	ids := []string{}
	for _, row := range kernelRows(s.Db, `SELECT t.id FROM project_archive_pauses p JOIN tasks t ON t.id=p.task_id
 JOIN work_graphs g ON g.graph_id=t.id WHERE g.work_id=? AND g.state='ready'
 AND `+taskPhaseIn("t.phase", taskPhaseArchivableList()...), workID) {
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

type DeletedTask struct {
	Rows int
}

func (s *TaskStore) ArchiveTask(taskID string) bool {
	return s.archiveOrRestore(taskID, NowMillis())
}

func (s *TaskStore) RestoreTask(taskID string) bool {
	return s.archiveOrRestore(taskID, 0)
}

func (s *TaskStore) archiveOrRestore(taskID string, at int64) bool {
	return s.Transaction(func() any {
		row := kernelRow(s.Db, "SELECT phase FROM tasks WHERE id=? AND deleted_at IS NULL", taskID)
		if row == nil {
			return false
		}
		if at != 0 && taskPhaseWorking(GraphPhase(kernelString(row["phase"]))) && !taskPhaseFinished(GraphPhase(kernelString(row["phase"]))) {
			return false
		}
		var stamp *int64
		if at != 0 {
			stamp = &at
		}
		changes, _ := g5Exec(s.Db, "UPDATE tasks SET archived_at=? WHERE id=? AND deleted_at IS NULL", stamp, taskID)
		if changes == 0 {
			return false
		}
		s.Event(taskID, "task.archived", map[string]any{"archived": at != 0, "at": at})
		return true
	}).(bool)
}

func (s *TaskStore) DeleteTask(taskID string) (DeletedTask, error) {
	result := s.Transaction(func() any {
		row := kernelRow(s.Db, "SELECT phase FROM tasks WHERE id=?", taskID)
		if row == nil {
			return DeletedTask{}
		}
		phase := GraphPhase(kernelString(row["phase"]))
		if !taskPhaseFinished(phase) {
			return errors.New("only a finished task can be deleted; archive it instead, or stop it first")
		}
		s.Event(taskID, "task.deleted", map[string]any{"at": NowMillis()})

		rows := 0
		tables, byColumn := s.taskScopedTables()
		tables = s.orderTablesLeavesFirst(tables)
		for pass := 0; pass <= len(tables)+1; pass++ {
			progressed := false
			for _, table := range tables {
				removed, refused := deleteIgnoringRefusal(s.Db, "DELETE FROM "+table+" WHERE "+byColumn[table]+"=?", taskID)
				if refused {
					continue
				}
				if removed > 0 {
					progressed = true
					rows += int(removed)
				}
			}
			if removed, refused := deleteIgnoringRefusal(s.Db, "DELETE FROM tasks WHERE id=?", taskID); !refused {
				return DeletedTask{Rows: rows + int(removed)}
			}
			if !progressed {
				return errors.New("deleting that task would leave rows pointing at it")
			}
		}
		return errors.New("deleting that task did not converge")
	})
	switch value := result.(type) {
	case DeletedTask:
		return value, nil
	case error:
		return DeletedTask{}, value
	}
	return DeletedTask{}, nil
}

func (s *TaskStore) taskScopedTables() ([]string, map[string]string) {
	rows := kernelRows(s.Db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
	tables := []string{}
	byColumn := map[string]string{}
	for _, row := range rows {
		name := kernelString(row["name"])
		if name == "tasks" {
			continue
		}
		if kernelRow(s.Db, "SELECT 1 FROM pragma_table_info(?) WHERE name='task_id'", name) != nil {
			tables = append(tables, name)
			byColumn[name] = "task_id"
			continue
		}
		for _, key := range kernelRows(s.Db, "SELECT \"table\" AS target, \"from\" AS column_name FROM pragma_foreign_key_list(?)", name) {
			if kernelString(key["target"]) == "tasks" {
				tables = append(tables, name)
				byColumn[name] = kernelString(key["column_name"])
				break
			}
		}
	}
	return tables, byColumn
}

func (s *TaskStore) ListedTaskCount() int {
	row := kernelRow(s.Db, "SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NULL AND deleted_at IS NULL")
	return int(kernelInt(row["n"]))
}

func (s *TaskStore) ArchivedTaskCount() int {
	row := kernelRow(s.Db, "SELECT COUNT(*) AS n FROM tasks WHERE archived_at IS NOT NULL AND deleted_at IS NULL")
	return int(kernelInt(row["n"]))
}

func deleteIgnoringRefusal(db *sql.DB, query string, args ...any) (removed int64, refused bool) {
	defer func() {
		if recovered := recover(); recovered != nil {
			removed, refused = 0, true
		}
	}()
	res, err := db.Exec(query, args...)
	if err != nil {
		return 0, true
	}
	changed, changedErr := res.RowsAffected()
	if changedErr != nil {
		return 0, true
	}
	return changed, false
}

func (s *TaskStore) orderTablesLeavesFirst(tables []string) []string {
	member := map[string]bool{}
	for _, table := range tables {
		member[table] = true
	}
	references := map[string][]string{}
	for _, table := range tables {
		for _, key := range kernelRows(s.Db, "SELECT \"table\" AS target FROM pragma_foreign_key_list(?)", table) {
			target := kernelString(key["target"])
			if member[target] {
				references[table] = append(references[table], target)
			}
		}
	}
	ordered := []string{}
	placed := map[string]bool{}
	for len(ordered) < len(tables) {
		progressed := false
		for _, table := range tables {
			if placed[table] {
				continue
			}
			ready := true
			for _, dependency := range references[table] {
				if placed[dependency] {
					ready = false
					break
				}
			}
			if !ready {
				continue
			}
			ordered = append(ordered, table)
			placed[table] = true
			progressed = true
		}
		if !progressed {
			for _, table := range tables {
				if !placed[table] {
					ordered = append(ordered, table)
					placed[table] = true
				}
			}
		}
	}
	return ordered
}
