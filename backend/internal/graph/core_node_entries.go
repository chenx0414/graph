package graph

import (
	"strings"

	"encoding/json"
)

type NodeEntryInput struct {
	TaskID       string `json:"taskId"`
	NodeID       string `json:"nodeId"`
	InstanceID   string `json:"instanceId,omitempty"`
	ActivationID string `json:"activationId,omitempty"`
	OperationID  string `json:"operationId,omitempty"`
	Role         string `json:"role"`
	Kind         string `json:"kind"`
	Text         string `json:"text"`
	Data         Json   `json:"data,omitempty"`
}

type nodeEntryEvent struct {
	NodeID           string `json:"nodeId"`
	ID               string `json:"id"`
	Seq              int64  `json:"seq"`
	Role             string `json:"role"`
	Kind             string `json:"kind"`
	Text             string `json:"text"`
	TextBytes        int64  `json:"textBytes"`
	ContentTruncated bool   `json:"contentTruncated"`
}

func parseJSONDocument(text string) (any, bool) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, false
	}
	return normalizeParsed(value), true
}

func nodeEntryID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func nodeEntryData(data Json) any {
	if data == nil {
		return nil
	}
	return CanonicalJSON(data)
}

func AppendNodeEntry(store *TaskStore, input NodeEntryInput) int64 {
	id := newUUID()
	insert := func() {
		kernelExec(store.Db, `INSERT INTO node_entries(id,task_id,node_id,instance_id,activation_id,operation_id,role,kind,text,data,created_at)
		  VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			id, input.TaskID, input.NodeID, nodeEntryID(input.InstanceID), nodeEntryID(input.ActivationID), nodeEntryID(input.OperationID),
			input.Role, input.Kind, input.Text, nodeEntryData(input.Data), NowMillis())
	}
	if store.IsTransaction() {
		insert()
	} else {
		store.Transaction(func() any { insert(); return nil })
	}
	row := kernelRow(store.Db, "SELECT seq FROM node_entries WHERE id=?", id)
	seq := kernelInt(row["seq"])
	textBytes := int64(len([]byte(input.Text)))
	truncated := textBytes > 4096
	text := input.Text
	if truncated {
		text = truncateRunes(input.Text, 512)
	}
	store.Event(input.TaskID, "node.entry", nodeEntryEvent{
		NodeID: input.NodeID, ID: id, Seq: seq, Role: input.Role, Kind: input.Kind,
		Text: text, TextBytes: textBytes, ContentTruncated: truncated,
	})
	return seq
}
