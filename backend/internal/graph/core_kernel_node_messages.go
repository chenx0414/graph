package graph

import "strings"

type NodeMessageInput struct {
	Text      string
	RequestID string
}

type nodeMessageQueued struct {
	Queued bool   `json:"queued"`
	Seq    any    `json:"seq"`
	TaskID string `json:"taskId"`
	NodeID string `json:"nodeId"`
}

type nodeMessageCommand struct {
	Text string  `json:"text"`
	From *string `json:"from"`
}

func SendKernelNodeMessage(kernel *KernelStore, graphID, nodeID string, input NodeMessageInput, from *string) any {
	text := strings.TrimSpace(input.Text)
	if text == "" || len([]rune(text)) > 100000 {
		Raise("invalid_input", "A message of 1–100000 characters is required")
	}
	actor := "user"
	if from != nil {
		actor = "peer:" + *from
	}
	return kernel.Store.Command("node-message:"+graphID+":"+nodeID+":"+actor, input.RequestID, nodeMessageCommand{Text: text, From: from}, func(tx *TaskStore) any {
		kernel := kernel.scoped(tx)
		if from != nil {
			nodes := revisionNodeMap(kernel.LatestRevision(graphID))
			if _, ok := nodes[*from]; !ok || *from == nodeID {
				Raise("invalid_input", "A peer sender must be another agent of this graph")
			}
		}
		display := text
		if from != nil {
			display = "From " + *from + ": " + text
		}
		queued := NewGraphRuntime(kernel, graphID, nil).Chat(nodeID, display, from != nil)
		seq := queuedSeq(queued)
		instanceID := nodeInstanceID(kernel.ListNodes(graphID), nodeID)
		data := map[string]any{"requestId": input.RequestID, "queueSeq": seq}
		role := "user"
		if from != nil {
			role = "assistant"
			data["from"] = *from
			data["peer"] = true
		}
		AppendNodeEntry(kernel.Store, NodeEntryInput{
			TaskID: graphID, NodeID: nodeID, InstanceID: instanceID, Role: role, Kind: "chat", Text: text, Data: data,
		})
		return nodeMessageQueued{Queued: true, Seq: seq, TaskID: graphID, NodeID: nodeID}
	})
}

func SendKernelMainMessage(kernel *KernelStore, graphID, from string, input NodeMessageInput) any {
	text := strings.TrimSpace(input.Text)
	if text == "" || len([]rune(text)) > 100000 {
		Raise("invalid_input", "A message of 1–100000 characters is required")
	}
	return kernel.Store.Command("node-message:"+graphID+":main:peer:"+from, input.RequestID, nodeMessageCommand{Text: text, From: &from}, func(tx *TaskStore) any {
		kernel := kernel.scoped(tx)
		graph := NewGraphRuntime(kernel, graphID, nil)
		nodes := revisionNodeMap(kernel.LatestRevision(graphID))
		if _, ok := nodes[from]; !ok {
			Raise("invalid_input", "A peer sender must be an agent of this graph")
		}
		phase := GraphPhase("")
		if state := graph.State(); state != nil {
			phase = state.Phase
		}
		if phase == PhaseCompleted {
			Raise("completing", "Graph "+graphID+" is completed; chat is closed")
		}
		if phase.Cancelling() {
			Raise("stopping", "Graph "+graphID+" is stopping; chat is closed")
		}
		conversation := SupervisorConversationForTask(kernel.Store, graphID)
		if conversation == nil {
			Raise("invalid_input", "Graph has no owning conversation")
		}
		conversationID := conversation.Id
		message := AppendMessage(kernel.Store, MessageInput{
			ConversationID: conversationID,
			Role:           "user",
			Kind:           "peer",
			Text:           "[" + from + "](graph://" + graphID + "/agents/" + encodeURIComponent(from) + "): " + text,
			State:          "pending",
			Data:           map[string]any{"graphId": graphID, "nodeId": from, "requestId": input.RequestID},
		})
		messageID := mapString(asMap(message), "id", "ID")
		WakeMaster(kernel.Store, WakeIntent{
			TaskID: graphID, Kind: "peer_message", DedupeKey: messageID, HasData: true,
			Data: map[string]any{"graphId": graphID, "nodeId": from, "messageId": messageID},
		})
		return message
	})
}

func revisionNodeMap(revision any) map[string]any {
	m := asMap(revision)
	if m == nil {
		return nil
	}
	def := asMap(firstPresent(m, "definition", "Definition"))
	if def == nil {
		return nil
	}
	nodes, _ := messageFirstPresent(def, "nodes", "Nodes").(map[string]any)
	return nodes
}

func messageFirstPresent(m map[string]any, keys ...string) any {
	for _, key := range keys {
		if v, ok := m[key]; ok {
			return v
		}
	}
	return nil
}

func queuedSeq(queued any) any {
	m := asMap(queued)
	if m == nil {
		return nil
	}
	if v, ok := m["seq"]; ok {
		return v
	}
	return m["Seq"]
}

func nodeInstanceID(nodes any, nodeID string) string {
	for _, item := range asSlice(nodes) {
		row, _ := item.(map[string]any)
		if mapString(row, "nodeId", "NodeID") == nodeID {
			return mapString(row, "instanceId", "InstanceID")
		}
	}
	panic("node instance missing")
}
