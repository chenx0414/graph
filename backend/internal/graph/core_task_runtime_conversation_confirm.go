package graph

import (
	"encoding/json"
	"strings"
)

// Confirm confirms one draft and creates the feature task it describes.
func (conversations *TaskRuntimeConversations) Confirm(conversationId string, input TaskRuntimeConfirmInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	bound := ConversationRowOf(runtime.store, conversationId)
	if bound.ProjectId == nil {
		Raise("invalid_input", "Bind a project before confirming a draft")
	}
	if strings.TrimSpace(input.TargetBranch) == "" {
		Raise("invalid_input", "A target branch is required")
	}
	runtime.git.RequireTargetBranch(*bound.ProjectId, input.TargetBranch)
	payload := map[string]any{
		"type": "confirm", "proposalVersion": input.ProposalVersion, "draftRevision": input.DraftRevision, "targetBranch": input.TargetBranch,
	}
	if input.Attestation != nil {
		payload["actor"] = input.Attestation.Actor
		payload["onBehalfOf"] = input.Attestation.OnBehalfOf
		payload["instruction"] = input.Attestation.Instruction
	}
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, payload, func() any {
		conversation := ConversationRowOf(runtime.store, conversationId)
		if conversation.ProjectId == nil {
			Raise("invalid_input", "Bind a project before confirming a draft")
		}
		requireProjectActive(runtime.store, *conversation.ProjectId)
		if strings.TrimSpace(input.TargetBranch) == "" {
			Raise("invalid_input", "A target branch is required")
		}
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		row := kernelRow(runtime.store.Db, "SELECT requirement_version,spec,decision_snapshot,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil || row["archived_at"] != nil ||
			anchor.LatestProposal != int64(input.ProposalVersion) ||
			kernelInt(row["requirement_version"]) != anchor.RequirementVersion {
			Raise("stale_proposal", "Only the current draft on the current requirement can be confirmed")
		}
		if input.DraftRevision != int(kernelInt(row["draft_revision"])) {
			Raise("stale_proposal", "This draft changed after it was reviewed; read it again before confirming")
		}
		if kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?", conversationId, input.ProposalVersion) != nil {
			Raise("already_accepted", "This draft was already confirmed")
		}
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &proposal); err != nil {
			panic(err)
		}
		ValidateProposal(proposal)
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		runtime.store.CreateConfirmedTask(taskId, *conversation.ProjectId, proposal.Summary, kernelInt(row["requirement_version"]), input.TargetBranch, "running", sequence, conversationId, row["decision_snapshot"])
		runtime.store.RecordProposal(taskId, 1, kernelInt(row["requirement_version"]), kernelString(row["spec"]), row["decision_snapshot"])
		MaterializeGraph(runtime.kernel, taskId, ParseGraphDefinition(proposal.Definition), "Confirmed conversation draft")
		runtime.store.BumpRequirementVersion(anchor.ID)
		kernelExec(runtime.store.Db, "INSERT INTO conversation_acceptances(conversation_id,proposal_version,task_id,target_branch,accepted_at,draft_revision) VALUES(?,?,?,?,?,?)",
			conversationId, input.ProposalVersion, taskId, input.TargetBranch, NowMillis(), kernelInt(row["draft_revision"]))
		AppendMessage(runtime.store, MessageInput{
			ConversationID: conversationId,
			Role:           MessageRoleSystem,
			Kind:           "confirmed",
			Text:           "已确认草稿 v" + itoa(input.ProposalVersion) + "，创建功能任务，等待 main 投递输入（目标分支 " + input.TargetBranch + "）",
			Data:           map[string]any{"taskId": taskId, "proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch},
		})
		runtime.store.Event(taskId, "task.created", map[string]any{"request": proposal.Summary, "conversationId": conversationId, "configRevision": runtime.configRevision()})
		return map[string]any{
			"conversationId":  conversationId,
			"taskId":          taskId,
			"targetBranch":    input.TargetBranch,
			"proposalVersion": input.ProposalVersion,
			"draftRevision":   kernelInt(row["draft_revision"]),
			"cursor":          runtime.store.Event(anchor.ID, "conversation.confirmed", map[string]any{"taskId": taskId, "proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	taskId, _ := record["taskId"].(string)
	if taskId != "" {
		runtime.git.PrepareTask(taskId, input.TargetBranch)
		if runtime.autoWake {
			runtime.execution.Kick()
		}
		if NewKernelStore(runtime.store).LatestRevision(taskId) != nil {
			WakeMaster(runtime.store, WakeIntent{TaskID: taskId, Kind: "graph_ready", DedupeKey: taskId + ":ready", Data: map[string]any{"graphId": taskId}, HasData: true})
		}
	}
	return record
}

// TaskRuntimeDraftInput archives, restores or deletes one draft version.
type TaskRuntimeDraftInput struct {
	ProposalVersion int
	RequestId       string
}

func (conversations *TaskRuntimeConversations) Pause(conversationId, requestId string) Receipt {
	conversation := ConversationRowOf(conversations.runtime.store, conversationId)
	return conversations.runtime.User().Task(conversation.AnchorTaskId).Pause(requestId)
}

// Resume resumes the anchor task of one conversation.
func (conversations *TaskRuntimeConversations) Resume(conversationId, requestId string) Receipt {
	conversation := ConversationRowOf(conversations.runtime.store, conversationId)
	return conversations.runtime.User().Task(conversation.AnchorTaskId).Resume(requestId)
}

// TaskRuntimeCancelInput cancels one queued message.
type TaskRuntimeCancelInput struct {
	MessageId string
	RequestId string
}

// CancelMessage drops one still-queued message of a conversation.
func (conversations *TaskRuntimeConversations) CancelMessage(conversationId string, input TaskRuntimeCancelInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if strings.TrimSpace(input.MessageId) == "" {
		Raise("invalid_input", "A messageId is required")
	}
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{
		"type": "cancel_message", "messageId": input.MessageId,
	}, func() any {
		cancelled := CancelQueuedMessage(runtime.store, conversationId, input.MessageId)
		var cursor any
		if cancelled.Changed {
			cursor = runtime.store.Event(conversation.AnchorTaskId, "message.cancelled", map[string]any{"messageId": input.MessageId})
		}
		return map[string]any{
			"conversationId": conversationId,
			"messageId":      input.MessageId,
			"state":          cancelled.State,
			"cancelled":      cancelled.Cancelled,
			"cursor":         cursor,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Steer hands the queued messages of a conversation to the live master turn.
func (conversations *TaskRuntimeConversations) Steer(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	active := kernelRow(runtime.store.Db, `
        SELECT o.id,o.spec
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `, conversationId)
	messages := PendingMessages(runtime.store, conversationId, 50)
	if len(messages) == 0 {
		return map[string]any{"conversationId": conversationId, "state": "empty", "steered": 0, "cursor": nil}
	}
	if active == nil {
		return map[string]any{"conversationId": conversationId, "state": "queued", "steered": 0, "cursor": nil}
	}
	var operation Operation
	if err := json.Unmarshal([]byte(kernelString(active["spec"])), &operation); err != nil {
		panic(err)
	}
	parts := []string{}
	for _, message := range messages {
		text := taskRuntimeSteeringText(message)
		if text != "" {
			parts = append(parts, text)
		}
	}
	combined := strings.Join(parts, "\n\n")
	if combined == "" {
		Raise("invalid_input", "Queued messages do not contain steerable text")
	}
	steered := runtime.execution.Interrupt(kernelString(active["id"]), &combined)
	ids := []string{}
	for _, message := range messages {
		ids = append(ids, message.Id)
	}
	receipt := runtime.store.Transaction(func() any {
		ordinal := -1
		if steered != nil {
			ordinal = int(*steered)
		}
		DeliverMessages(runtime.store, kernelString(active["id"]), operation.Attempt, messages, ordinal)
		cursor := runtime.store.Event(conversation.AnchorTaskId, "message.steered", map[string]any{
			"operationId": kernelString(active["id"]),
			"messageIds":  ids,
			"requestId":   requestId,
		})
		return map[string]any{"conversationId": conversationId, "state": "steered", "steered": len(ids), "cursor": cursor}
	})
	record, _ := jsonRecord(receipt)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Interrupt stops the live master turn of a conversation.
func (conversations *TaskRuntimeConversations) Interrupt(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	active := kernelRow(runtime.store.Db, `
        SELECT o.id
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `, conversationId)
	if active == nil {
		return map[string]any{"conversationId": conversationId, "state": "idle", "requestId": requestId}
	}
	runtime.execution.Interrupt(kernelString(active["id"]), nil)
	return map[string]any{"conversationId": conversationId, "state": "interrupted", "requestId": requestId}
}
