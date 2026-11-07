package graph

import (
	"os"
	"strings"

	"encoding/json"
)

type RecordedPrompt struct {
	OperationID string  `json:"operationId"`
	At          int64   `json:"at"`
	Text        string  `json:"text"`
	Tools       *string `json:"tools"`
}

type NodeBriefing struct {
	Text        string `json:"text"`
	SessionFile string `json:"sessionFile"`
}

func NodePromptDetail(store *TaskStore, taskId, nodeId string) NodePromptView {
	row := kernelRow(store.Db, "SELECT spec, instance_id, status FROM nodes WHERE task_id = ? AND id = ?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	kind := spec.Kind
	if kind == "" {
		kind = "agent"
	}
	notes := []string{}
	recorded := store.NodeSystemPrompt(taskId, nodeId)
	var recordedValue any
	if recorded != nil {
		prompt := &RecordedPrompt{OperationID: recorded.OperationID, At: recorded.At, Text: recorded.Text}
		if recorded.Tools.Valid {
			tools := recorded.Tools.String
			prompt.Tools = &tools
		}
		recordedValue = prompt
	}
	var briefing *NodeBriefing
	if kind != "agent" {
		notes = append(notes, "程序节点：它在进程内运行，不会被发送 system prompt。")
		if recorded != nil {
			notes = append(notes, "节点类型已改变，但台账里仍留着它更早那次作为 agent 发送的记录。")
		}
	} else {
		if recorded == nil {
			notes = append(notes, "台账里没有这个节点的发送记录：它可能还没发送过，也可能这份记录还没有写回来。")
		}
		instanceId := kernelString(row["instance_id"])
		var session map[string]any
		if instanceId != "" {
			session = kernelRow(store.Db, "SELECT session_file FROM node_sessions WHERE instance_id = ?", instanceId)
		}
		if session == nil {
			notes = append(notes, "该节点没有自己的会话，简报无法找回。")
		} else {
			file := kernelString(session["session_file"])
			text := firstUserMessage(file)
			if text == nil {
				notes = append(notes, "它的会话（"+file+"）里没有 user 消息。")
			} else {
				briefing = &NodeBriefing{Text: *text, SessionFile: file}
			}
		}
	}
	return NodePromptView{
		TaskID: taskId, NodeID: nodeId, Kind: kind, Action: spec.Action, Role: promptRole(spec, kind),
		DefinitionVersion: spec.DefinitionVersion, Model: spec.Model, Status: kernelString(row["status"]),
		Recorded: recordedValue, Briefing: briefing, Notes: notes,
	}
}

func firstUserMessage(file string) *string {
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		entry, ok := parseJSONDocument(line)
		if !ok {
			continue
		}
		message := asMap(asMap(entry)["message"])
		if message == nil {
			continue
		}
		if mapString(message, "role") != "user" {
			continue
		}
		content, present := message["content"]
		if !present {
			continue
		}
		if text, ok := content.(string); ok && text != "" {
			return &text
		}
		if parts, ok := content.([]any); ok {
			var builder strings.Builder
			for _, part := range parts {
				if text, ok := part.(string); ok {
					builder.WriteString(text)
					continue
				}
				builder.WriteString(mapString(asMap(part), "text"))
			}
			if builder.Len() > 0 {
				text := builder.String()
				return &text
			}
		}
	}
	return nil
}

func promptRole(spec NodeSpec, kind string) *string {
	if kind != "agent" {
		return nil
	}
	if spec.Role != nil && *spec.Role == "master" {
		value := "main"
		return &value
	}
	if strings.Contains(strings.ToLower(spec.Action), "review") {
		value := "reviewer"
		return &value
	}
	value := "worker"
	return &value
}
