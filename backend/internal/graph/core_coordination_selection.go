package graph

func (runtime *TaskRuntime) SelectProjectThread(projectID, conversationID, requestID string) SupervisorThread {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[projectID] {
		Raise("invalid_input", "A configured project is required")
	}
	result := func() any {
		graphDatabaseMu.Lock()
		defer graphDatabaseMu.Unlock()
		return runtime.store.Command("supervisor:select:"+projectID, requestID, map[string]any{"conversationId": conversationID}, func() any {
			selected := ConversationRowOf(runtime.store, conversationID)
			if selected.ProjectId == nil || *selected.ProjectId != projectID || (selected.Role != ConversationLegacy && selected.Role != ConversationProject) {
				Raise("invalid_input", "Select an existing conversation of this project")
			}
			existing := kernelRow(runtime.store.Db, "SELECT id FROM conversations WHERE role='project' AND project_id=?", projectID)
			if existing != nil && kernelString(existing["id"]) != conversationID {
				Raise("invalid_input", "The project already has a supervisor thread")
			}
			blocked := kernelRow(runtime.store.Db, `SELECT t.id FROM tasks t JOIN conversations c ON c.id=t.conversation_id
    WHERE c.project_id=? AND c.id!=? AND c.role='legacy' AND t.phase NOT IN ('chatting','completed','stopped','abandoned')
    AND NOT EXISTS (SELECT 1 FROM kernel_revisions r WHERE r.task_id=t.id) LIMIT 1`, projectID, conversationID)
			if blocked != nil {
				Raise("migration_in_progress", "Another conversation still owns unfinished work; transfer it before choosing a supervisor")
			}
			active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o JOIN conversations c ON c.anchor_task_id=o.task_id
    WHERE c.project_id=? AND c.id!=? AND c.role='legacy' AND (o.worker_active=1 OR o.state IN ('intent','dispatched','unknown')) LIMIT 1`, projectID, conversationID)
			pending := kernelRow(runtime.store.Db, `SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
    JOIN tasks anchor ON anchor.id=c.anchor_task_id
    WHERE c.project_id=? AND c.id!=? AND c.role='legacy' AND m.state IN ('pending','queued')
    AND (m.kind NOT IN ('peer','chat') OR (m.kind='chat' AND (m.role!='user' OR anchor.paused!=0 OR c.archived_at IS NOT NULL))) LIMIT 1`, projectID, conversationID)
			if active != nil || pending != nil {
				Raise("migration_in_progress", "Another conversation has an unfinished turn; settle it before choosing a supervisor")
			}
			if selected.ArchivedAt != nil {
				runtime.store.RestoreConversation(conversationID)
			}
			runtime.store.AssignConversationRole(conversationID, ConversationProject)
			for _, old := range kernelRows(runtime.store.Db, "SELECT id,anchor_task_id FROM conversations WHERE project_id=? AND role='legacy' AND id!=?", projectID, conversationID) {
				oldID, oldAnchor := kernelString(old["id"]), kernelString(old["anchor_task_id"])
				graphs := kernelRows(runtime.store.Db, `SELECT t.id FROM tasks t WHERE t.conversation_id=?
 AND t.phase NOT IN ('chatting','completed','stopped','abandoned') AND EXISTS (SELECT 1 FROM kernel_revisions r WHERE r.task_id=t.id)`, oldID)
				for _, graph := range graphs {
					graphID := kernelString(graph["id"])
					runtime.kernel.TransferGraphOwner(graphID, selected.AnchorTaskId)
					runtime.store.Event(graphID, "graph.supervisor_transferred", map[string]any{"fromConversationId": oldID, "toConversationId": conversationID, "ownerTaskId": selected.AnchorTaskId})
					WakeMaster(runtime.store, WakeIntent{TaskID: graphID, Kind: "graph_transferred", DedupeKey: graphID + ":transferred", Data: map[string]any{"graphId": graphID, "sourceConversationId": oldID}, HasData: true})
				}
				if kernelRow(runtime.store.Db, "SELECT id FROM wake_intents WHERE task_id=? AND state IN ('waiting','ready') LIMIT 1", oldAnchor) != nil && questionMasterNode(runtime.store, selected.AnchorTaskId) == nil {
					Raise("migration_in_progress", "The selected supervisor needs a configured agent before notifications can be transferred")
				}
				messages := TransferLegacyPendingMessages(runtime.store, oldID, conversationID)
				TransferLegacyGraphWakes(runtime.store, oldAnchor, selected.AnchorTaskId, oldID, messages)
				runtime.store.AssignConversationRole(oldID, ConversationHistory)
			}
			runtime.store.Event(selected.AnchorTaskId, "conversation.supervisor_selected", map[string]any{"conversationId": conversationID, "projectId": projectID})
			return supervisorThreadOf(ConversationRowOf(runtime.store, conversationID))
		})
	}()
	if runtime.autoWake {
		runtime.execution.Kick()
		go runtime.recoverTransferredGraphPreparations()
	}
	if thread, ok := result.(SupervisorThread); ok {
		return thread
	}
	record, _ := jsonRecord(result)
	return supervisorThreadOf(ConversationRowOf(runtime.store, kernelString(record["conversationId"])))
}
