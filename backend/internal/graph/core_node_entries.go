package graph

import (
	"encoding/json"
	"strings"
)

// NodeEntryInput is one display entry appended to a node transcript.
//
// The optional identifiers are plain strings: the empty string stands for the
// SQL NULL the TypeScript `string | null | undefined` produced.
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

// nodeEntryEvent is the payload of the node.entry event.
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

// parseJSONDocument parses one JSON document and reports failure instead of
// panicking, the way the TypeScript try/catch did.
func parseJSONDocument(text string) (any, bool) {
	dec := json.NewDecoder(strings.NewReader(text))
	dec.UseNumber()
	var value any
	if err := dec.Decode(&value); err != nil {
		return nil, false
	}
	return normalizeParsed(value), true
}

// nodeEntryID maps an absent identifier onto SQL NULL.
func nodeEntryID(value string) any {
	if value == "" {
		return nil
	}
	return value
}

// nodeEntryData maps an absent payload onto SQL NULL and a present one onto its
// canonical JSON.
func nodeEntryData(data Json) any {
	if data == nil {
		return nil
	}
	return CanonicalJSON(data)
}

// AppendNodeEntry appends one display entry from a real Pi session event. The
// task event stream also receives it so node details can update without a
// refetch race.
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
		// TODO(port): TypeScript sliced UTF-16 code units; this slices runes.
		text = truncateRunes(input.Text, 512)
	}
	store.Event(input.TaskID, "node.entry", nodeEntryEvent{
		NodeID: input.NodeID, ID: id, Seq: seq, Role: input.Role, Kind: input.Kind,
		Text: text, TextBytes: textBytes, ContentTruncated: truncated,
	})
	return seq
}
