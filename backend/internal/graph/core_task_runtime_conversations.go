package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// Conversations returns the conversation side of the runtime.
func (runtime *TaskRuntime) Conversations() *TaskRuntimeConversations {
	return &TaskRuntimeConversations{runtime: runtime}
}

// TaskRuntimeConversationInput starts one conversation.
type TaskRuntimeConversationInput struct {
	ProjectId     *string
	Title         *string
	Text          *string
	Attachments   []AttachmentInput
	Model         *string
	ThinkingLevel *string
	RequestId     string
}

// Create starts one conversation.
func (conversations *TaskRuntimeConversations) Create(input TaskRuntimeConversationInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversationId := graphUUID()
	attachments := CleanAttachments(input.Attachments)
	if input.ProjectId == nil {
		if err := os.MkdirAll(filepath.Join(runtime.stateDir, "conversations", conversationId), 0o700); err != nil {
			panic(err)
		}
	}
	result := runtime.store.Command("conversations", input.RequestId, map[string]any{
		"type":          "create",
		"projectId":     input.ProjectId,
		"title":         input.Title,
		"text":          input.Text,
		"attachments":   attachments,
		"model":         input.Model,
		"thinkingLevel": input.ThinkingLevel,
	}, func() any {
		text := ""
		if input.Text != nil {
			text = strings.TrimSpace(*input.Text)
		}
		if text == "" && len(attachments) == 0 {
			Raise("invalid_input", "A nonempty first message or attachment is required")
		}
		projectId := input.ProjectId
		workspaceProjectId := ""
		if projectId != nil {
			if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", *projectId) == nil {
				Raise("invalid_input", "A known project is required")
			}
			if !runtime.allowedProjects()[*projectId] {
				Raise("invalid_input", "The project is no longer part of the current configuration")
			}
			workspaceProjectId = *projectId
		} else {
			// The host-owned scratch workspace keeps an unbound conversation on
			// the ordinary project/grant path without granting any real root.
			root := filepath.Join(runtime.stateDir, "conversations", conversationId)
			kernelExec(runtime.store.Db, "INSERT INTO projects(id,root,grants) VALUES(?,?,?)", "conversation:"+conversationId, root, "[]")
			workspaceProjectId = "conversation:" + conversationId
		}
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		title := "新对话"
		if input.Title != nil && strings.TrimSpace(*input.Title) != "" {
			title = strings.TrimSpace(*input.Title)
		} else if text != "" {
			title = text
		}
		if len([]rune(title)) > 120 {
			title = string([]rune(title)[:120])
		}
		runtime.store.CreateConversationTask(taskId, workspaceProjectId, title, "chatting", sequence, conversationId)
		kernelExec(runtime.store.Db, "INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,?,?,?)",
			conversationId, projectId, workspaceProjectId, taskId, title, sequence, NowMillis())
		if runtime.master != nil && runtime.masterModel() != nil {
			runtime.createMasterNode(taskId)
			requestedModel := ""
			if input.Model != nil {
				requestedModel = strings.TrimSpace(*input.Model)
			}
			var selected *ConfiguredModel
			if requestedModel != "" {
				for _, entry := range runtime.liveConfiguredEntries() {
					if entry.Id == requestedModel {
						candidate := entry
						selected = &candidate
						break
					}
				}
				if selected == nil {
					Raise("model_unavailable", "The selected model is not configured")
				}
			}
			if selected != nil {
				master := kernelRow(runtime.store.Db, "SELECT spec,instance_id FROM nodes WHERE task_id=? AND id='master'", taskId)
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(master["spec"])), &spec); err != nil {
					panic(err)
				}
				spec.Model = &selected.Id
				runtime.store.SetNodeSpec(taskId, "master", CanonicalJSON(spec))
				kernelExec(runtime.store.Db, "UPDATE instances SET model=? WHERE id=?", selected.Id, kernelString(master["instance_id"]))
			}
			effective := selected
			if effective == nil {
				master := runtime.masterModel()
				if master != nil {
					for _, entry := range runtime.liveConfiguredEntries() {
						if entry.Id == *master {
							candidate := entry
							effective = &candidate
							break
						}
					}
				}
			}
			var requestedLevel *string
			if input.ThinkingLevel != nil {
				level := taskRuntimeAsThinkingLevel(*input.ThinkingLevel)
				requestedLevel = &level
			}
			if effective != nil {
				level := EffectiveThinkingLevel(effective.ModelEntry, requestedLevel)
				kernelExec(runtime.store.Db, "UPDATE conversations SET thinking_level=? WHERE id=?", string(level), conversationId)
			}
		}
		cursor := runtime.store.Event(taskId, "conversation.created", map[string]any{"conversationId": conversationId, "projectId": projectId, "title": title})
		var messageId any
		if text != "" || len(attachments) > 0 {
			data := any(nil)
			if len(attachments) > 0 {
				data = map[string]any{"attachments": attachments}
			}
			message := AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleUser,
				Kind:           "chat",
				Text:           text,
				State:          MessageStatePending,
				Data:           data,
			})
			messageId = message.Id
			if runtime.master != nil {
				// The node was just created, so it is already pending. The TypeScript
				// host wrote this status in the same synchronous block that created the
				// node, so it could never park a turn that was already running. The Go
				// host runs the creation and the dispatch on separate goroutines, so the
				// same write is guarded the way `say` guards it: a master that is
				// already preparing or running keeps its turn.
				row := kernelRow(runtime.store.Db, "SELECT status FROM nodes WHERE task_id=? AND id='master'", taskId)
				status := kernelString(row["status"])
				if status != "preparing" && status != "running" {
					runtime.store.SetNodePending(taskId, "master")
				}
			}
			if message.Cursor != nil {
				cursor = *message.Cursor
			}
		}
		return map[string]any{
			"conversationId": conversationId,
			"taskId":         taskId,
			"title":          title,
			"messageId":      messageId,
			"cursor":         cursor,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// liveConfiguredEntries reads the configured models as configuration entries.
func (runtime *TaskRuntime) liveConfiguredEntries() []ConfiguredModel {
	if runtime.live != nil && runtime.live.Entries != nil {
		return runtime.live.Entries()
	}
	if runtime.models != nil {
		return runtime.models.Entries
	}
	return []ConfiguredModel{}
}

// createMasterNode records the master node of one task.
func (runtime *TaskRuntime) createMasterNode(taskId string) string {
	model := runtime.masterModel()
	definitionVersion := runtime.masterDefinitionVersion()
	if model == nil {
		Raise("models_missing", "No configured model for a master agent")
	}
	if definitionVersion == nil {
		Raise("definition_missing", "No configured definition for a master agent")
	}
	spec := NodeSpec{
		Id:                "master",
		Kind:              "agent",
		Action:            runtime.master.Action,
		DefinitionVersion: definitionVersion,
		Model:             model,
		Role:              taskRuntimeStringPtr("master"),
	}
	instanceId := graphUUID()
	runtime.store.CreateNode(taskId, spec.Id, CanonicalJSON(spec), instanceId)
	runtime.insertInstance(instanceId, taskId, spec.Id, spec.DefinitionVersion, spec.Model)
	CreateActivation(runtime.store, taskId, spec.Id, 0)
	return instanceId
}
