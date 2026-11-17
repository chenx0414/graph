package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

func (runtime *TaskRuntime) Conversations() *TaskRuntimeConversations {
	return &TaskRuntimeConversations{runtime: runtime}
}

type TaskRuntimeConversationInput struct {
	ProjectId     *string
	Title         *string
	Text          *string
	Attachments   []AttachmentInput
	Model         *string
	ThinkingLevel *string
	RequestId     string
}

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
			if kernelRow(runtime.store.Db, "SELECT id FROM conversations WHERE project_id=? AND role='project'", *projectId) != nil {
				Raise("invalid_input", "This project already has a supervisor thread; open that thread instead")
			}
			if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", *projectId) == nil {
				Raise("invalid_input", "A known project is required")
			}
			if !runtime.allowedProjects()[*projectId] {
				Raise("invalid_input", "The project is no longer part of the current configuration")
			}
			workspaceProjectId = *projectId
		} else {
			root := filepath.Join(runtime.stateDir, "conversations", conversationId)
			runtime.store.RegisterProject("conversation:"+conversationId, root, "[]")
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
		runtime.store.CreateConversationTask(taskId, workspaceProjectId, title, string(PhaseChatting), sequence, conversationId)
		runtime.store.CreateConversation(conversationId, projectId, workspaceProjectId, taskId, title, sequence, NowMillis())
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
				runtime.store.SetInstanceModel(kernelString(master["instance_id"]), selected.Id)
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
				runtime.store.SetConversationThinkingLevel(conversationId, string(level))
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
		runtime.refuseUndispatchableTurn(conversationId)
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

func (runtime *TaskRuntime) liveConfiguredEntries() []ConfiguredModel {
	entries := []ConfiguredModel{}
	if runtime.live != nil && runtime.live.Entries != nil {
		entries = runtime.live.Entries()
	} else if runtime.models != nil {
		entries = runtime.models.Entries
	}
	if runtime.magpie != nil {
		entries = runtime.magpie.Merge(entries)
	}
	return entries
}

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
	runtime.store.CreateActivation(taskId, spec.Id, 0)
	return instanceId
}
