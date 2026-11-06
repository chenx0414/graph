package graph

import (
	"strings"
)

// Supervisor returns the control surface of one task.
func (runtime *TaskRuntime) Supervisor(taskId string) *TaskRuntimeSupervisor {
	return &TaskRuntimeSupervisor{runtime: runtime, taskId: taskId}
}

// TaskRuntimeControlInput is one control action of the main Agent.
type TaskRuntimeControlInput struct {
	Action          string
	TaskId          *string
	NodeId          *string
	Text            *string
	Tokens          *int64
	Reason          *string
	RequestId       string
	SourceMessageID string
	Instruction     string
}

// ControlTask applies one control action of the main Agent.
func (supervisor *TaskRuntimeSupervisor) ControlTask(input TaskRuntimeControlInput) any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if input.RequestId == "" || len(input.RequestId) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	target := supervisor.controlTarget(input.TaskId)
	scope := "supervisor:" + supervisor.taskId
	switch input.Action {
	case "pause", "resume":
		paused := input.Action == "pause"
		stoppedMaster := false
		payload := map[string]any{"type": input.Action, "taskId": target}
		if input.SourceMessageID != "" || input.Instruction != "" {
			payload["sourceMessageId"] = input.SourceMessageID
			payload["instruction"] = input.Instruction
		}
		receipt := runtime.store.Command(scope, input.RequestId, payload, func() any {
			if !paused {
				requireArchiveResumeInstruction(runtime.store, supervisor.taskId, target, input.SourceMessageID, input.Instruction)
			}
			pausedValue := 0
			if paused {
				pausedValue = 1
			}
			runtime.store.SetTaskPaused(target, pausedValue != 0)
			if runtime.kernel.LatestRevision(target) != nil {
				runtime.kernel.SetNativePause(target, paused, "", 0)
			}
			if paused {
				OpenPause(runtime.kernel, target)
				active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o
                  JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
                  WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                    AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`, target)
				if active != nil {
					stoppedMaster = AwaitPauseContinuation(runtime.store, input.RequestId, target, kernelString(active["id"]))
				}
			} else {
				ClosePause(runtime.kernel, target)
				ResumePauseContinuations(runtime.store, target)
			}
			eventType := "task.resumed"
			if paused {
				eventType = "task.pause_requested"
			}
			return map[string]any{
				"taskId": target,
				"cursor": runtime.store.Event(target, eventType, map[string]any{"actor": "agent", "reason": reasonValue(input.Reason)}),
			}
		})
		if paused && stoppedMaster {
			runtime.execution.StopActiveMasterTurns(target)
		} else if !paused && runtime.autoWake {
			runtime.execution.Kick()
		}
		return receipt
	case "abandon":
		reason := ""
		if input.Reason != nil {
			reason = strings.TrimSpace(*input.Reason)
		}
		if reason == "" {
			Raise("invalid_input", "Abandoning a task needs a recorded reason")
		}
		return runtime.store.Command(scope, input.RequestId, map[string]any{"type": "abandon", "taskId": target, "reason": reason}, func() any {
			return map[string]any{
				"taskId": target,
				"cursor": runtime.execution.Abandon(target, &reason, true),
			}
		})
	case "steer":
		nodeId := ""
		if input.NodeId != nil {
			nodeId = strings.TrimSpace(*input.NodeId)
		}
		text := ""
		if input.Text != nil {
			text = strings.TrimSpace(*input.Text)
		}
		if nodeId == "" {
			Raise("invalid_input", "steer needs the node whose running turn receives the message")
		}
		if text == "" {
			Raise("invalid_input", "A nonempty steering message is required")
		}
		if runtime.kernel.LatestRevision(target) != nil {
			return runtime.steerGraphNode(supervisor.taskId, target, nodeId, text, input.RequestId)
		}
		active := ActiveOperationForNode(runtime.store, target, nodeId)
		if active == nil {
			Raise("steering_unavailable", "Node "+nodeId+" has no running turn to steer")
		}
		steered := runtime.execution.Steer(active.Id, text)
		return runtime.store.Transaction(func() any {
			return map[string]any{
				"taskId":      target,
				"nodeId":      nodeId,
				"operationId": active.Id,
				"steered":     steered,
				"cursor":      runtime.store.Event(target, "operation.steered", map[string]any{"nodeId": nodeId, "operationId": active.Id, "actor": "agent", "text": text}),
			}
		})
	case "stop_node":
		if input.NodeId == nil || strings.TrimSpace(*input.NodeId) == "" {
			Raise("invalid_input", "stop_node needs the node to stop")
		}
		return runtime.stopGraphNode(supervisor.taskId, target, strings.TrimSpace(*input.NodeId), input.RequestId)
	}
	Raise("invalid_input", "Unknown control action "+input.Action)
	return nil
}

// controlTarget names the task a control action may act on.
func (supervisor *TaskRuntimeSupervisor) controlTarget(requested *string) string {
	target := supervisor.taskId
	if requested != nil && strings.TrimSpace(*requested) != "" {
		target = strings.TrimSpace(*requested)
	}
	if target == supervisor.taskId {
		return target
	}
	conversation := runtime2Conversation(supervisor.runtime, supervisor.taskId)
	targetConversation := runtime2Conversation(supervisor.runtime, target)
	if conversation == nil || targetConversation == nil || *targetConversation != *conversation {
		Raise("invalid_input", "Control reaches only tasks of this conversation")
	}
	return target
}

// runtime2Conversation reads the conversation of one task.
func runtime2Conversation(runtime *TaskRuntime, taskId string) *string {
	if owner, ok := runtime.kernel.GraphOwner(taskId); ok {
		return runtime.store.Task(owner).ConversationID
	}
	conversation := runtime.store.Task(taskId).ConversationID
	return conversation
}

// TaskRuntimeProposeInput is one proposal of the main Agent.
type TaskRuntimeProposeInput struct {
	ProposalVersion int
	Summary         string
	Acceptance      []AcceptanceItem
	Decisions       []string
	HasDecisions    bool
	Definition      GraphDefinition
	RequestId       string
	NewVersion      bool
}

// Propose records one draft of the main Agent.
func (supervisor *TaskRuntimeSupervisor) Propose(input TaskRuntimeProposeInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	proposal := NativeProposal{
		RequirementVersion: input.ProposalVersion,
		Summary:            input.Summary,
		Acceptance:         input.Acceptance,
		Decisions:          input.Decisions,
		Definition:         input.Definition,
	}
	result := runtime.store.Command("supervisor:"+supervisor.taskId, input.RequestId, map[string]any{
		"type": "propose", "proposal": proposal, "newVersion": input.NewVersion,
	}, func() any {
		task := runtime.store.Task(supervisor.taskId)
		if task.AcceptedProposal != nil {
			Raise("requirements_locked", "This task already has a confirmed graph: revise the running graph with graph_patch instead of proposing a new draft")
		}
		if task.RequirementVersion != int64(input.ProposalVersion) {
			Raise("stale_requirement", "Proposal uses an old requirement version")
		}
		ValidateProposal(proposal)
		spec := CanonicalJSON(proposal)
		digest := ContentDigest(spec)
		conversation := ConversationForTask(runtime.store, supervisor.taskId)
		var current map[string]any
		if task.LatestProposal > 0 {
			current = kernelRow(runtime.store.Db, "SELECT version,requirement_version,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", supervisor.taskId, task.LatestProposal)
		}
		confirmed := false
		if current != nil && conversation != nil {
			confirmed = kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?",
				conversation.Id, kernelInt(current["version"])) != nil
		}
		inPlace := current != nil && !input.NewVersion && !confirmed &&
			kernelInt(current["requirement_version"]) == int64(input.ProposalVersion) &&
			current["archived_at"] == nil && current["deleted_at"] == nil
		highWater := kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(version),0) AS max FROM proposals WHERE task_id=?", supervisor.taskId)["max"])
		version := int(highWater) + 1
		if int(task.LatestProposal) > version {
			version = int(task.LatestProposal) + 1
		}
		draftRevision := 1
		if inPlace {
			version = int(kernelInt(current["version"]))
			draftRevision = int(kernelInt(current["draft_revision"])) + 1
		}
		var snapshot *string
		if input.HasDecisions {
			curated := []string{}
			for _, decision := range input.Decisions {
				trimmed := strings.TrimSpace(decision)
				if trimmed == "" {
					continue
				}
				curated = append(curated, trimmed)
			}
			lines := []string{}
			for _, decision := range curated {
				lines = append(lines, "- "+decision)
			}
			text := strings.Join(lines, "\n")
			snapshot = &text
		} else if conversation != nil {
			since := conversation.BindingSinceSeq
			rows := kernelRows(runtime.store.Db, "SELECT seq,text FROM messages WHERE conversation_id=? AND role='user' AND state='delivered' AND seq>? ORDER BY seq", conversation.Id, since)
			if len(rows) > DECISION_DIGEST_MAX_MESSAGES {
				head := rows[:DECISION_DIGEST_HEAD]
				tail := rows[len(rows)-DECISION_DIGEST_TAIL:]
				rows = append(append([]map[string]any{}, head...), tail...)
			}
			lines := []string{}
			for _, row := range rows {
				text := kernelString(row["text"])
				if !StatesADecision(text) {
					continue
				}
				trimmed := text
				if len([]rune(trimmed)) > 240 {
					trimmed = string([]rune(trimmed)[:240])
				}
				lines = append(lines, "- [msg "+itoa(int(kernelInt(row["seq"])))+"] "+trimmed)
			}
			for len(lines) > 1 && len(strings.Join(lines, "\n")) > DECISION_DIGEST_MAX_CHARS {
				index := (len(lines) - 1) / 2
				lines = append(lines[:index], lines[index+1:]...)
			}
			if len(lines) > 0 {
				text := strings.Join(lines, "\n")
				snapshot = &text
			}
		}
		if inPlace {
			runtime.store.UpdateProposalDraft(supervisor.taskId, int64(version), int64(input.ProposalVersion), spec, snapshot, int64(draftRevision), digest)
		} else {
			runtime.store.RecordProposalDraft(supervisor.taskId, int64(version), int64(input.ProposalVersion), spec, snapshot, int64(draftRevision), digest)
		}
		if task.LatestProposal != int64(version) {
			runtime.store.SetTaskLatestProposal(supervisor.taskId, version)
		}
		eventType := "proposal.created"
		if inPlace {
			eventType = "proposal.edited"
		}
		return map[string]any{
			"taskId":          supervisor.taskId,
			"proposalVersion": version,
			"draftRevision":   draftRevision,
			"cursor":          runtime.store.Event(supervisor.taskId, eventType, map[string]any{"proposalVersion": version, "draftRevision": draftRevision}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	// The notes travel with the receipt so the author reads them without asking
	// for a second opinion they did not know existed.
	if notes := ProposalShapeNotes(proposal); len(notes) > 0 {
		record["shapeNotes"] = notes
	}
	return record
}

// TaskRuntimeWithdrawInput withdraws one draft of the main Agent.
type TaskRuntimeWithdrawInput struct {
	ProposalVersion int
	Reason          *string
	RequestId       string
}

// WithdrawDraft retires the current unconfirmed draft.
func (supervisor *TaskRuntimeSupervisor) WithdrawDraft(input TaskRuntimeWithdrawInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("supervisor:"+supervisor.taskId, input.RequestId, map[string]any{"type": "withdraw", "proposalVersion": input.ProposalVersion}, func() any {
		task := runtime.store.Task(supervisor.taskId)
		row := kernelRow(runtime.store.Db, "SELECT version FROM proposals WHERE task_id=? AND version=?", supervisor.taskId, input.ProposalVersion)
		if row == nil {
			Raise("not_found", "That draft does not exist")
		}
		if task.LatestProposal != int64(input.ProposalVersion) {
			Raise("stale_proposal", "Only the current draft can be withdrawn")
		}
		if task.AcceptedProposal != nil {
			Raise("requirements_locked", "A confirmed draft cannot be withdrawn")
		}
		conversation := ConversationForTask(runtime.store, supervisor.taskId)
		if conversation != nil && kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?",
			conversation.Id, input.ProposalVersion) != nil {
			Raise("already_accepted", "This draft was already confirmed")
		}
		next := input.ProposalVersion + 1
		runtime.store.SetTaskLatestProposal(supervisor.taskId, next)
		reason := ""
		if input.Reason != nil {
			reason = strings.TrimSpace(*input.Reason)
		}
		if conversation != nil {
			text := "草稿 v" + itoa(input.ProposalVersion) + " 已作废，请重新调查后生成新草稿。"
			if reason != "" {
				text = "草稿 v" + itoa(input.ProposalVersion) + " 已作废：" + reason + "。请重新调查后生成新草稿。"
			}
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversation.Id,
				Role:           MessageRoleSystem,
				Kind:           "project",
				State:          MessageStateDone,
				Text:           text,
			})
		}
		return map[string]any{
			"taskId":              supervisor.taskId,
			"withdrawnVersion":    input.ProposalVersion,
			"nextProposalVersion": next,
			"cursor":              runtime.store.Event(supervisor.taskId, "proposal.withdrawn", map[string]any{"proposalVersion": input.ProposalVersion, "reason": reason}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// ValidateProposal checks one draft against the current requirement.
func (supervisor *TaskRuntimeSupervisor) ValidateProposal(proposal NativeProposal) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	task := runtime.store.Task(supervisor.taskId)
	if task.RequirementVersion != int64(proposal.RequirementVersion) {
		Raise("stale_requirement", "Proposal uses an old requirement version")
	}
	ValidateProposal(proposal)
	answer := map[string]any{"valid": true, "requirementVersion": task.RequirementVersion}
	if notes := ProposalShapeNotes(proposal); len(notes) > 0 {
		answer["shapeNotes"] = notes
	}
	return answer
}
