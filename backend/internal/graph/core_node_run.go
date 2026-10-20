package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
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

// CapabilityLoadFact is the canonical capability load fact (src/core/node-run.ts).
// The runtime declares the same name with more fields; that one is
// RuntimeCapabilityLoadFact, which lives with the runtime loader.
type CapabilityLoadFact struct {
	ID          string   `json:"id"`
	Version     string   `json:"version"`
	Kind        *string  `json:"kind"`
	Loaded      bool     `json:"loaded"`
	Executable  bool     `json:"executable"`
	Reason      *string  `json:"reason"`
	Name        *string  `json:"name,omitempty"`
	Description *string  `json:"description,omitempty"`
	Path        *string  `json:"path,omitempty"`
	Tools       []string `json:"tools,omitempty"`
}

// CapabilityUsageFact is one capability's tool-call statistics.
type CapabilityUsageFact struct {
	ID           string   `json:"id"`
	Version      string   `json:"version"`
	Kind         *string  `json:"kind"`
	Name         string   `json:"name"`
	Tools        []string `json:"tools"`
	Calls        int      `json:"calls"`
	Successes    int      `json:"successes"`
	Failures     int      `json:"failures"`
	Pending      int      `json:"pending"`
	LastCalledAt *int64   `json:"lastCalledAt"`
	SuccessRate  *float64 `json:"successRate"`
}

// NodeCapabilityLoadInput is one recorded capability load.
type NodeCapabilityLoadInput struct {
	TaskId              string
	NodeId              string
	InstanceId          string
	OperationId         string
	ReadOnly            bool
	Report              []RuntimeCapabilityLoadFact
	Digest              string
	ToolPolicyDigest    string
	RuntimePolicyDigest string
}

// nodeCapabilityLoadRecord is the stored `loaded` document.
type nodeCapabilityLoadRecord struct {
	Version             int                         `json:"version"`
	Digest              *string                     `json:"digest"`
	ToolPolicyDigest    *string                     `json:"toolPolicyDigest"`
	RuntimePolicyDigest *string                     `json:"runtimePolicyDigest"`
	Facts               []RuntimeCapabilityLoadFact `json:"facts"`
}

// nodeEntryOptional maps an absent digest onto JSON null.
func nodeEntryOptional(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

// RecordCapabilityLoad stores what was actually loaded for one node run, so a
// later projection never has to guess from catalog status.
func RecordCapabilityLoad(store *TaskStore, input NodeCapabilityLoadInput) {
	facts := input.Report
	if facts == nil {
		facts = []RuntimeCapabilityLoadFact{}
	}
	record := nodeCapabilityLoadRecord{
		Version:             2,
		Digest:              nodeEntryOptional(input.Digest),
		ToolPolicyDigest:    nodeEntryOptional(input.ToolPolicyDigest),
		RuntimePolicyDigest: nodeEntryOptional(input.RuntimePolicyDigest),
		Facts:               facts,
	}
	kernelExec(store.Db, `INSERT INTO node_capabilities(task_id,node_id,instance_id,operation_id,read_only,loaded,created_at)
	  VALUES(?,?,?,?,?,?,?)`,
		input.TaskId, input.NodeId, nodeEntryID(input.InstanceId), nodeEntryID(input.OperationId),
		nodeEntryReadOnly(input.ReadOnly), CanonicalJSON(record), NowMillis())
}

// nodeEntryReadOnly maps the read-only flag onto the stored integer.
func nodeEntryReadOnly(readOnly bool) int {
	if readOnly {
		return 1
	}
	return 0
}

// RecordNodeSession records the Pi session a node instance is bound to.
func RecordNodeSession(store *TaskStore, instanceId, sessionId, sessionFile string) {
	kernelExec(store.Db, "INSERT OR REPLACE INTO node_sessions VALUES(?,?,?,?)",
		instanceId, sessionId, nodeEntryID(sessionFile), NowMillis())
}

// NodeEntry is one row of a node transcript.
type NodeEntry struct {
	Seq              int64   `json:"seq"`
	ID               string  `json:"id"`
	Role             string  `json:"role"`
	Kind             string  `json:"kind"`
	Text             string  `json:"text"`
	Data             Json    `json:"data"`
	OperationID      *string `json:"operationId"`
	CreatedAt        int64   `json:"createdAt"`
	ContentTruncated bool    `json:"contentTruncated"`
	ContentBytes     int64   `json:"contentBytes"`
}

// NodeEntryPage is one page of a node transcript.
type NodeEntryPage struct {
	Entries    []NodeEntry `json:"entries"`
	EntryCount int         `json:"entryCount"`
	Limit      int         `json:"limit"`
	HasOlder   bool        `json:"hasOlder"`
	HasNewer   bool        `json:"hasNewer"`
}

// nodeEntryColumns is the shared projection of one transcript page. A full
// entry keeps its whole body; a preview truncates it.
func nodeEntryColumns(full bool) string {
	flag := "0"
	if full {
		flag = "1"
	}
	return `seq,id,role,kind,operation_id,created_at,
    length(CAST(text AS BLOB)) AS text_bytes,COALESCE(length(CAST(data AS BLOB)),0) AS data_bytes,
    CASE WHEN ` + flag + ` OR length(CAST(text AS BLOB))<=4096 THEN text ELSE substr(text,1,512) END AS text,
    CASE WHEN ` + flag + ` OR length(CAST(data AS BLOB))<=4096 OR data IS NULL THEN data ELSE
      json_object('toolName',substr(json_extract(data,'$.toolName'),1,128),
        'toolCallId',substr(json_extract(data,'$.toolCallId'),1,256),
        'from',substr(json_extract(data,'$.from'),1,128),
        'peer',json(CASE WHEN json_extract(data,'$.peer')=1 THEN 'true' ELSE 'false' END),
        'isError',json(CASE WHEN json_extract(data,'$.isError')=1 OR json_extract(data,'$.error')=1 THEN 'true' ELSE 'false' END),
        'ordinal',json_extract(data,'$.ordinal')) END AS data`
}

// nodeEntryLimit is the page size of a transcript query.
func nodeEntryLimit(query NodeEntryQuery) int {
	if query.Limit != nil && isSafeInteger(*query.Limit) && *query.Limit > 0 {
		limit := int(*query.Limit)
		if limit > 500 {
			return 500
		}
		return limit
	}
	return 100
}

// nodeEntryMap turns transcript rows into entries.
func nodeEntryMap(rows []map[string]any, full bool) []NodeEntry {
	entries := make([]NodeEntry, 0, len(rows))
	for _, row := range rows {
		var data Json
		if text := kernelString(row["data"]); text != "" {
			data = parseJSON(text)
		}
		var operationID *string
		if row["operation_id"] != nil {
			value := kernelString(row["operation_id"])
			operationID = &value
		}
		textBytes := kernelInt(row["text_bytes"])
		dataBytes := kernelInt(row["data_bytes"])
		entries = append(entries, NodeEntry{
			Seq: kernelInt(row["seq"]), ID: kernelString(row["id"]), Role: kernelString(row["role"]),
			Kind: kernelString(row["kind"]), Text: kernelString(row["text"]), Data: data,
			OperationID: operationID, CreatedAt: kernelInt(row["created_at"]),
			ContentTruncated: !full && (textBytes > 4096 || dataBytes > 4096),
			ContentBytes:     textBytes + dataBytes,
		})
	}
	return entries
}

// ListNodeEntries pages one node's transcript. Stable forward/backward
// pagination; large records are fetched individually.
func ListNodeEntries(store *TaskStore, taskId, nodeId string, query NodeEntryQuery) NodeEntryPage {
	limit := nodeEntryLimit(query)
	countRow := kernelRow(store.Db, "SELECT COUNT(*) AS count FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
	entryCount := int(kernelInt(countRow["count"]))
	full := query.EntryID != nil
	columns := nodeEntryColumns(full)
	if full {
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries WHERE task_id=? AND node_id=? AND id=?`,
			taskId, nodeId, *query.EntryID)
		if len(rows) == 0 {
			Raise("not_found", "Entry does not belong to this node")
		}
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: 1, HasOlder: false, HasNewer: false}
	}
	if query.Before != nil {
		// Backward page: the entries directly before the cursor, oldest-first.
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
      WHERE task_id=? AND node_id=? AND seq<? ORDER BY seq DESC LIMIT ?`, taskId, nodeId, *query.Before, limit)
		reverseNodeEntries(rows)
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: true, HasNewer: false}
	}
	if query.After != nil {
		// Forward page from a known cursor.
		after := int64(0)
		if isSafeInteger(*query.After) && *query.After >= 0 {
			after = int64(*query.After)
		}
		rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
      WHERE task_id=? AND node_id=? AND seq>? ORDER BY seq LIMIT ?`, taskId, nodeId, after, limit)
		hasNewer := false
		if len(rows) == limit && entryCount > 0 {
			maxRow := kernelRow(store.Db, "SELECT MAX(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
			maxSeq := kernelInt(maxRow["seq"])
			hasNewer = kernelInt(rows[len(rows)-1]["seq"]) < maxSeq
		}
		return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: true, HasNewer: hasNewer}
	}
	// No cursor: the newest page. The initial view must show the live tail; the
	// UI then pages backward with `before` until it reaches the first entry.
	rows := kernelRows(store.Db, `SELECT `+columns+` FROM node_entries
    WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT ?`, taskId, nodeId, limit)
	oldest := int64(0)
	if len(rows) > 0 {
		oldest = kernelInt(rows[len(rows)-1]["seq"])
	}
	reverseNodeEntries(rows)
	firstRow := kernelRow(store.Db, "SELECT MIN(seq) AS seq FROM node_entries WHERE task_id=? AND node_id=?", taskId, nodeId)
	hasOlder := false
	if firstRow != nil && firstRow["seq"] != nil {
		hasOlder = oldest > kernelInt(firstRow["seq"])
	}
	return NodeEntryPage{Entries: nodeEntryMap(rows, full), EntryCount: entryCount, Limit: limit, HasOlder: hasOlder, HasNewer: false}
}

// reverseNodeEntries flips a descending page into ascending order.
func reverseNodeEntries(rows []map[string]any) {
	for left, right := 0, len(rows)-1; left < right; left, right = left+1, right-1 {
		rows[left], rows[right] = rows[right], rows[left]
	}
}

// NodeCapabilityView is one bound capability in the node detail.
type NodeCapabilityView struct {
	ID         string   `json:"id"`
	Version    string   `json:"version"`
	Kind       *string  `json:"kind"`
	Name       string   `json:"name"`
	Tools      []string `json:"tools"`
	Bound      bool     `json:"bound"`
	Loaded     *bool    `json:"loaded"`
	Executable *bool    `json:"executable"`
	State      string   `json:"state"`
	Reason     *string  `json:"reason"`
}

// NodeRunNode is the node identity inside the node detail.
type NodeRunNode struct {
	ID                string          `json:"id"`
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	Role              *string         `json:"role"`
	Status            string          `json:"status"`
	ActivationID      *string         `json:"activationId"`
	OutputVersion     int64           `json:"outputVersion"`
	StallCount        int64           `json:"stallCount"`
	DefinitionVersion *string         `json:"definitionVersion,omitempty"`
	Input             json.RawMessage `json:"input,omitempty"`
}

// NodeRunInstance is the instance a node runs in.
type NodeRunInstance struct {
	ID                string   `json:"id"`
	Model             *string  `json:"model"`
	DefinitionVersion *string  `json:"definitionVersion"`
	Used              int64    `json:"used"`
	Budget            *int64   `json:"budget"`
	Unlimited         bool     `json:"unlimited"`
	ModelsUsed        []string `json:"modelsUsed"`
}

// NodeRunSession is the Pi session a node instance is bound to.
type NodeRunSession struct {
	SessionID   string  `json:"sessionId"`
	SessionFile *string `json:"sessionFile"`
}

// NodeRunInvocation is one provider call of a node.
type NodeRunInvocation struct {
	ID          string      `json:"id"`
	Model       string      `json:"model"`
	Purpose     string      `json:"purpose"`
	Usage       *TokenUsage `json:"usage"`
	UsageSource UsageSource `json:"usageSource"`
	Cost        Json        `json:"cost"`
}

// NodeRunQuestion is one question a node asked.
type NodeRunQuestion struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"`
	Status string `json:"status"`
	Data   Json   `json:"data"`
}

// NodeRunEvidence is one acceptance item a node proved.
type NodeRunEvidence struct {
	AcceptanceID string  `json:"acceptanceId"`
	Valid        bool    `json:"valid"`
	CommitSha    *string `json:"commitSha"`
}

// NodeRunTiming is the time ledger of a node.
type NodeRunTiming struct {
	TotalMs    *int64 `json:"totalMs"`
	RunMs      *int64 `json:"runMs"`
	WaitingMs  int64  `json:"waitingMs"`
	PauseMs    *int64 `json:"pauseMs"`
	UserWaitMs *int64 `json:"userWaitMs"`
	InProgress bool   `json:"inProgress"`
}

// NodeRunView is the read-only node detail.
type NodeRunView struct {
	TaskID           string                `json:"taskId"`
	NodeID           string                `json:"nodeId"`
	Context          *ContextFacts         `json:"context"`
	Capabilities     []NodeCapabilityView  `json:"capabilities"`
	CapabilityUsage  []CapabilityUsageFact `json:"capabilityUsage"`
	CapabilityDigest *string               `json:"capabilityDigest"`
	Node             NodeRunNode           `json:"node"`
	Instance         *NodeRunInstance      `json:"instance"`
	Session          *NodeRunSession       `json:"session"`
	Operations       []OperationRun        `json:"operations"`
	Invocations      []NodeRunInvocation   `json:"invocations"`
	Questions        []NodeRunQuestion     `json:"questions"`
	Evidence         []NodeRunEvidence     `json:"evidence"`
	Timing           NodeRunTiming         `json:"timing"`
	Entries          []NodeEntry           `json:"entries"`
	EntryCount       int                   `json:"entryCount"`
	HasOlder         bool                  `json:"hasOlder"`
	HasNewer         bool                  `json:"hasNewer"`
	Phase            string                `json:"phase"`
}

// nodeRunSpec is the v1 node declaration stored in nodes.spec.
type nodeRunSpec struct {
	Kind              string          `json:"kind"`
	Action            string          `json:"action"`
	DefinitionVersion *string         `json:"definitionVersion"`
	Role              *string         `json:"role"`
	Input             json.RawMessage `json:"input"`
}

// nodeRunDefinitionSpec is the capability binding of a stored definition.
type nodeRunDefinitionSpec struct {
	Capabilities []struct {
		ID      string `json:"id"`
		Version string `json:"version"`
	} `json:"capabilities"`
	Prompts *struct {
		Agent *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"agent"`
		Tool *struct {
			ID      string `json:"id"`
			Version string `json:"version"`
		} `json:"tool"`
	} `json:"prompts"`
}

// nodeRunBinding is one capability bound to a node.
type nodeRunBinding struct {
	ID      string
	Version string
}

// nodeRunDefinitionMatch splits a `id@version` definition reference.
var nodeRunDefinitionMatch = regexp.MustCompile(`^(.*)@(\d+)$`)

// NodeRun reads the read-only node detail: definition identity, session
// reference, entries and per-operation timing where credential waiting is
// separated from run time.
func NodeRun(store *TaskStore, taskId, nodeId string, query NodeEntryQuery) NodeRunView {
	task := store.Task(taskId)
	node := kernelRow(store.Db, "SELECT id,spec,instance_id,status,activation_id,output_version,stall_count FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if node == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	var spec nodeRunSpec
	if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
		panic(err)
	}
	capabilities, capabilityDigest := nodeRunCapabilities(store, taskId, nodeId, spec, task.Phase)
	var instance *NodeRunInstance
	if instanceId := kernelString(node["instance_id"]); instanceId != "" {
		row := kernelRow(store.Db, "SELECT id,model,definition_version,used,budget,unlimited,models_used FROM instances WHERE id=?", instanceId)
		if row != nil {
			view := &NodeRunInstance{
				ID: kernelString(row["id"]), Used: kernelInt(row["used"]),
				Unlimited: kernelInt(row["unlimited"]) != 0,
			}
			if row["model"] != nil {
				value := kernelString(row["model"])
				view.Model = &value
			}
			if row["definition_version"] != nil {
				value := kernelString(row["definition_version"])
				view.DefinitionVersion = &value
			}
			if !view.Unlimited {
				budget := kernelInt(row["budget"])
				view.Budget = &budget
			}
			modelsUsed := []string{}
			if raw := kernelString(row["models_used"]); raw != "" {
				var parsed []string
				if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
					panic(err)
				}
				modelsUsed = parsed
			}
			view.ModelsUsed = modelsUsed
			instance = view
		}
	}
	var session *NodeRunSession
	if instanceId := kernelString(node["instance_id"]); instanceId != "" {
		row := kernelRow(store.Db, "SELECT session_id,session_file FROM node_sessions WHERE instance_id=?", instanceId)
		if row != nil {
			view := &NodeRunSession{SessionID: kernelString(row["session_id"])}
			if row["session_file"] != nil {
				value := kernelString(row["session_file"])
				view.SessionFile = &value
			}
			session = view
		}
	}
	operations := NodeOperationRuns(store, taskId, nodeId)
	if operations == nil {
		operations = []OperationRun{}
	}
	invocations := []NodeRunInvocation{}
	for _, row := range kernelRows(store.Db, `SELECT i.id,i.model,i.usage,i.cost,i.purpose FROM invocations i JOIN operations o ON o.id=i.operation_id
    WHERE o.task_id=? AND o.node_id=? ORDER BY i.rowid`, taskId, nodeId) {
		var usage *TokenUsage
		if raw := kernelString(row["usage"]); raw != "" {
			parsed := &TokenUsage{}
			if err := json.Unmarshal([]byte(raw), parsed); err != nil {
				panic(err)
			}
			usage = parsed
		}
		var cost Json
		if raw := kernelString(row["cost"]); raw != "" {
			cost = parseJSON(raw)
		}
		invocations = append(invocations, NodeRunInvocation{
			ID: kernelString(row["id"]), Model: kernelString(row["model"]), Purpose: kernelString(row["purpose"]),
			Usage: usage, UsageSource: UsageSourceOf(usage), Cost: cost,
		})
	}
	questions := []NodeRunQuestion{}
	for _, row := range kernelRows(store.Db, "SELECT id,kind,status,data FROM questions WHERE task_id=? AND node_id=? ORDER BY rowid", taskId, nodeId) {
		questions = append(questions, NodeRunQuestion{
			ID: kernelString(row["id"]), Kind: kernelString(row["kind"]), Status: kernelString(row["status"]),
			Data: parseJSON(kernelString(row["data"])),
		})
	}
	evidence := []NodeRunEvidence{}
	for _, row := range kernelRows(store.Db, "SELECT acceptance_id,valid,commit_sha FROM evidence WHERE task_id=? AND node_id=? ORDER BY rowid", taskId, nodeId) {
		item := NodeRunEvidence{AcceptanceID: kernelString(row["acceptance_id"]), Valid: kernelInt(row["valid"]) != 0}
		if row["commit_sha"] != nil {
			value := kernelString(row["commit_sha"])
			item.CommitSha = &value
		}
		evidence = append(evidence, item)
	}
	page := ListNodeEntries(store, taskId, nodeId, query)
	usageFacts := nodeRunCapabilityUsage(store, taskId, nodeId, capabilities)
	// Time segments come from authoritative state timestamps, never from the
	// message span. "Still running" is a property of the current lifecycle:
	// a terminal node is never in progress because of a historical attempt.
	nodeTerminal := map[string]bool{"succeeded": true, "skipped": true, "retired": true, "failed": true}[kernelString(node["status"])]
	active := 0
	for _, operation := range operations {
		if operation.WorkerActive || operation.State == "dispatched" || operation.State == "running" {
			active++
		}
	}
	inProgress := !nodeTerminal && active > 0
	settled := []OperationRun{}
	for _, operation := range operations {
		if operation.DispatchedAt != nil && operation.SettledAt != nil {
			settled = append(settled, operation)
		}
	}
	ledger := NodeTimeLedgerOf(store, taskId, nodeId)
	timing := NodeRunTiming{InProgress: inProgress}
	if len(settled) > 0 {
		maxSettled := int64(0)
		minDispatched := int64(0)
		runMs := int64(0)
		for index, operation := range settled {
			if index == 0 || *operation.SettledAt > maxSettled {
				maxSettled = *operation.SettledAt
			}
			if index == 0 || *operation.DispatchedAt < minDispatched {
				minDispatched = *operation.DispatchedAt
			}
			if operation.RunMs != nil {
				runMs += *operation.RunMs
			}
		}
		total := maxSettled - minDispatched
		if total < 0 {
			total = 0
		}
		timing.TotalMs = &total
		timing.RunMs = &runMs
	}
	for _, operation := range operations {
		timing.WaitingMs += operation.WaitingMs
	}
	// Recorded pause / user-wait segments; a historical node without ledger
	// facts stays "未记录" instead of being inferred from message times.
	timing.PauseMs = ledger.PauseMs
	timing.UserWaitMs = ledger.UserWaitMs
	nodeView := NodeRunNode{
		ID: kernelString(node["id"]), Kind: spec.Kind, Action: spec.Action, Role: spec.Role,
		Status:        kernelString(node["status"]),
		OutputVersion: kernelInt(node["output_version"]), StallCount: kernelInt(node["stall_count"]),
	}
	if node["activation_id"] != nil {
		value := kernelString(node["activation_id"])
		nodeView.ActivationID = &value
	}
	if spec.DefinitionVersion != nil && *spec.DefinitionVersion != "" {
		value := *spec.DefinitionVersion
		nodeView.DefinitionVersion = &value
	}
	if len(spec.Input) > 0 {
		nodeView.Input = spec.Input
	}
	return NodeRunView{
		TaskID: taskId, NodeID: nodeId, Context: ContextView(store, taskId, nodeId),
		Capabilities: capabilities, CapabilityUsage: usageFacts, CapabilityDigest: capabilityDigest,
		Node: nodeView, Instance: instance, Session: session, Operations: operations,
		Invocations: invocations, Questions: questions, Evidence: evidence, Timing: timing,
		Entries: page.Entries, EntryCount: page.EntryCount, HasOlder: page.HasOlder, HasNewer: page.HasNewer,
		Phase: task.Phase,
	}
}

// nodeRunCapabilities reads the capability view: definition binding plus the
// actual load fact recorded for this node. No record means "not recorded",
// never a guessed true.
func nodeRunCapabilities(store *TaskStore, taskId, nodeId string, spec nodeRunSpec, taskPhase string) ([]NodeCapabilityView, *string) {
	empty := []NodeCapabilityView{}
	if spec.DefinitionVersion == nil || *spec.DefinitionVersion == "" {
		return empty, nil
	}
	match := nodeRunDefinitionMatch.FindStringSubmatch(*spec.DefinitionVersion)
	if match == nil {
		return empty, nil
	}
	version, err := strconv.Atoi(match[2])
	if err != nil {
		return empty, nil
	}
	definition := kernelRow(store.Db, "SELECT spec FROM definitions WHERE id=? AND version=?", match[1], version)
	if definition == nil {
		return empty, nil
	}
	var parsed nodeRunDefinitionSpec
	if err := json.Unmarshal([]byte(kernelString(definition["spec"])), &parsed); err != nil {
		panic(err)
	}
	factRow := kernelRow(store.Db, "SELECT loaded,read_only FROM node_capabilities WHERE task_id=? AND node_id=? ORDER BY seq DESC LIMIT 1", taskId, nodeId)
	facts := map[string]CapabilityLoadFact{}
	var capabilityDigest *string
	if factRow != nil {
		loaded := parseJSON(kernelString(factRow["loaded"]))
		if list, ok := loaded.([]any); ok {
			for _, item := range list {
				fact := nodeRunCapabilityFact(item)
				facts[fact.ID+"@"+fact.Version] = fact
			}
		} else if record := asMap(loaded); record != nil {
			if digest, ok := record["digest"].(string); ok {
				value := digest
				capabilityDigest = &value
			}
			for _, item := range asSlice(record["facts"]) {
				fact := nodeRunCapabilityFact(item)
				facts[fact.ID+"@"+fact.Version] = fact
			}
		}
	}
	bindings := []nodeRunBinding{}
	for _, bound := range parsed.Capabilities {
		bindings = append(bindings, nodeRunBinding{ID: bound.ID, Version: bound.Version})
	}
	if parsed.Prompts != nil && parsed.Prompts.Agent != nil {
		bindings = append(bindings, nodeRunBinding{ID: parsed.Prompts.Agent.ID, Version: parsed.Prompts.Agent.Version})
	}
	if parsed.Prompts != nil && parsed.Prompts.Tool != nil {
		bindings = append(bindings, nodeRunBinding{ID: parsed.Prompts.Tool.ID, Version: parsed.Prompts.Tool.Version})
	}
	views := make([]NodeCapabilityView, 0, len(bindings))
	for _, bound := range bindings {
		views = append(views, nodeRunCapabilityView(store, bound, facts, factRow != nil, spec, taskPhase))
	}
	return views, capabilityDigest
}

// nodeRunCapabilityFact parses one stored load fact.
func nodeRunCapabilityFact(item any) CapabilityLoadFact {
	raw, err := json.Marshal(item)
	if err != nil {
		panic(err)
	}
	var fact CapabilityLoadFact
	if err := json.Unmarshal(raw, &fact); err != nil {
		panic(err)
	}
	return fact
}

// nodeRunCapabilityView is one bound capability of a node.
func nodeRunCapabilityView(store *TaskStore, bound nodeRunBinding, facts map[string]CapabilityLoadFact, hasFactRow bool, spec nodeRunSpec, taskPhase string) NodeCapabilityView {
	catalog := kernelRow(store.Db, "SELECT kind,source,snapshot FROM capabilities WHERE id=? AND version=?", bound.ID, bound.Version)
	catalogName := bound.ID
	if catalog != nil {
		if snapshot, ok := parseJSONDocument(kernelString(catalog["snapshot"])); ok {
			if record := asMap(snapshot); record != nil {
				if name, ok := record["name"].(string); ok && strings.TrimSpace(name) != "" {
					catalogName = name
				}
			}
		}
	}
	fact, hasFact := facts[bound.ID+"@"+bound.Version]
	// Authoritative current-state derivation for the one case the loading
	// code skips by contract: a remote MCP is never loaded in read-only
	// discussion. This is not a guess from catalog status.
	remote := false
	if catalog != nil && kernelString(catalog["kind"]) == "mcp" {
		remote = nodeRunRemoteMCP(kernelString(catalog["source"]))
	}
	master := spec.Role != nil && *spec.Role == "master"
	if !hasFact && !hasFactRow && remote && master && (taskPhase == "chatting" || taskPhase == "discussing") {
		loaded := false
		executable := false
		reason := "只读讨论模式不加载远程能力"
		kind := "mcp"
		return NodeCapabilityView{
			ID: bound.ID, Version: bound.Version, Kind: &kind, Name: catalogName, Tools: []string{},
			Bound: true, Loaded: &loaded, Executable: &executable, State: "禁用", Reason: &reason,
		}
	}
	if !hasFact {
		var kind *string
		if catalog != nil {
			value := kernelString(catalog["kind"])
			kind = &value
		}
		state := "未记录"
		reason := "该节点没有能力加载记录（历史或尚未运行）"
		if hasFactRow {
			state = "未加载"
			reason = "本次运行未加载该能力"
		}
		return NodeCapabilityView{
			ID: bound.ID, Version: bound.Version, Kind: kind, Name: catalogName, Tools: []string{},
			Bound: true, Loaded: nil, Executable: nil, State: state, Reason: &reason,
		}
	}
	name := catalogName
	if fact.Name != nil {
		name = *fact.Name
	}
	tools := fact.Tools
	if tools == nil {
		tools = []string{}
	}
	loaded := fact.Loaded
	executable := fact.Executable
	state := "禁用"
	if fact.Loaded {
		if fact.Executable {
			state = "可执行"
		} else {
			state = "已加载"
		}
	}
	return NodeCapabilityView{
		ID: fact.ID, Version: fact.Version, Kind: fact.Kind, Name: name, Tools: tools,
		Bound: true, Loaded: &loaded, Executable: &executable, State: state, Reason: fact.Reason,
	}
}

// nodeRunRemoteMCP reports whether a capability is a remote MCP server, which
// is never loaded in a read-only discussion.
func nodeRunRemoteMCP(source string) bool {
	raw, err := os.ReadFile(filepath.Join(source, "capability.json"))
	if err != nil {
		return false
	}
	var manifest map[string]any
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return false
	}
	_, hasCommand := manifest["command"].(string)
	return !hasCommand
}

// nodeRunCapabilityUsage counts the tool calls each bound capability owns.
func nodeRunCapabilityUsage(store *TaskStore, taskId, nodeId string, facts []NodeCapabilityView) []CapabilityUsageFact {
	rows := kernelRows(store.Db, `SELECT kind,data,created_at FROM node_entries
    WHERE task_id=? AND node_id=? AND role='tool' AND kind IN ('call','result') ORDER BY seq`, taskId, nodeId)
	type toolCall struct {
		toolName string
		calledAt int64
		failed   bool
		settled  bool
	}
	calls := map[string]*toolCall{}
	for _, row := range rows {
		raw := kernelString(row["data"])
		if raw == "" {
			continue
		}
		data := asMap(parseJSON(raw))
		if data == nil {
			continue
		}
		toolCallID, ok := data["toolCallId"].(string)
		if !ok || toolCallID == "" {
			continue
		}
		if kernelString(row["kind"]) == "call" {
			toolName, ok := data["toolName"].(string)
			if !ok || toolName == "" {
				continue
			}
			calls[toolCallID] = &toolCall{toolName: toolName, calledAt: kernelInt(row["created_at"])}
			continue
		}
		if call, ok := calls[toolCallID]; ok {
			call.failed = data["isError"] == true
			call.settled = true
		}
	}
	toolOwners := map[string]string{}
	for _, fact := range facts {
		for _, tool := range fact.Tools {
			toolOwners[tool] = fact.ID + "@" + fact.Version
		}
	}
	type toolStat struct {
		calls        int
		successes    int
		failures     int
		pending      int
		lastCalledAt *int64
	}
	stats := map[string]*toolStat{}
	for _, call := range calls {
		owner, ok := toolOwners[call.toolName]
		if !ok {
			continue
		}
		current, ok := stats[owner]
		if !ok {
			current = &toolStat{}
			stats[owner] = current
		}
		current.calls++
		switch {
		case !call.settled:
			current.pending++
		case call.failed:
			current.failures++
		default:
			current.successes++
		}
		if current.lastCalledAt == nil || call.calledAt > *current.lastCalledAt {
			value := call.calledAt
			current.lastCalledAt = &value
		}
	}
	out := make([]CapabilityUsageFact, 0, len(facts))
	for _, fact := range facts {
		current, ok := stats[fact.ID+"@"+fact.Version]
		if !ok {
			current = &toolStat{}
		}
		settled := current.successes + current.failures
		var successRate *float64
		if settled > 0 {
			value := float64(current.successes) / float64(settled)
			successRate = &value
		}
		tools := fact.Tools
		if tools == nil {
			tools = []string{}
		}
		out = append(out, CapabilityUsageFact{
			ID: fact.ID, Version: fact.Version, Kind: fact.Kind, Name: fact.Name, Tools: tools,
			Calls: current.calls, Successes: current.successes, Failures: current.failures,
			Pending: current.pending, LastCalledAt: current.lastCalledAt, SuccessRate: successRate,
		})
	}
	return out
}
