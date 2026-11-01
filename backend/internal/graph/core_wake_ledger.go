package graph

import (
	"strings"

	"strconv"
)

// Why the master of a conversation is being woken.
type WakeKind string

type WakeIntent struct {
	TaskID    string
	Kind      WakeKind
	DedupeKey string
	// Data nil means the TypeScript property was omitted (SQL NULL), not JSON null.
	Data any
	// HasData is set when the caller passed data, including an explicit JSON null.
	HasData bool
}

type PendingWake struct {
	ID        int64
	TaskID    string
	Kind      WakeKind
	DedupeKey string
	Data      *string
}

// WakeMaster records one wake for the conversation's master and makes it dispatchable.
func WakeMaster(store *TaskStore, intent WakeIntent) bool {
	apply := func() any {
		row, ok := sqliteOne(store.DB, `SELECT c.id AS conversation_id,c.anchor_task_id,c.archived_at,m.id AS master_id
      FROM tasks t
      LEFT JOIN kernel_graph_owners g ON g.task_id=t.id
      LEFT JOIN tasks owner ON owner.id=g.owner_task_id
      JOIN conversations c ON c.id=COALESCE(owner.conversation_id,t.conversation_id)
      JOIN nodes m ON m.task_id=c.anchor_task_id AND json_extract(m.spec,'$.role')='master'
      JOIN tasks a ON a.id=c.anchor_task_id
      WHERE t.id=?`, intent.TaskID)
		if !ok || row["archived_at"] != nil {
			return false
		}
		anchorTaskID := sqlString(row["anchor_task_id"])
		anchor := store.Task(anchorTaskID)
		if mapString(asMap(anchor), "phase", "Phase") != "chatting" {
			return false
		}
		var data any
		if intent.HasData {
			data = intent.Data
		}
		// The TypeScript stored the data whenever the property was present, so a
		// caller that passes data without the flag still gets it stored. Only an
		// omitted property is SQL NULL.
		var stored any
		if intent.HasData || intent.Data != nil {
			data = intent.Data
			stored = stringifyJSON(data)
		}
		inserted := sqliteChanges(store.DB, `INSERT OR IGNORE INTO wake_intents(task_id,node_id,kind,dedupe_key,data,state)
      VALUES(?,?,?,?,?,'waiting')`, anchorTaskID, sqlString(row["master_id"]), string(intent.Kind), intent.DedupeKey, stored)
		if inserted == 0 {
			return false
		}
		promoted := sqliteChanges(store.DB, "UPDATE wake_intents SET state='ready' WHERE task_id=? AND node_id=? AND kind=? AND dedupe_key=? AND state='waiting'",
			anchorTaskID, sqlString(row["master_id"]), string(intent.Kind), intent.DedupeKey)
		if promoted == 0 {
			return false
		}
		store.ResumeSucceededNode(anchorTaskID, sqlString(row["master_id"]))
		store.Event(anchorTaskID, "wake.ready", map[string]any{
			"kind": intent.Kind, "dedupeKey": intent.DedupeKey, "taskId": intent.TaskID, "nodeId": sqlString(row["master_id"]),
		})
		return true
	}
	result := withStoreTx(store, apply)
	ok, _ := result.(bool)
	return ok
}

type BlockedNodeWake struct {
	NodeID      string
	Reason      string
	IncidentID  string
	HasIncident bool
}

func WakeForBlockedNode(store *TaskStore, taskID string, block BlockedNodeWake) bool {
	dedupe := taskID + ":" + block.NodeID + ":"
	if block.HasIncident {
		dedupe += block.IncidentID
	} else {
		dedupe += block.Reason
	}
	data := map[string]any{"nodeId": block.NodeID, "reason": block.Reason, "graphId": taskID}
	if block.HasIncident {
		data["incidentId"] = block.IncidentID
	}
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "node_blocked", DedupeKey: dedupe, Data: data, HasData: true})
}

// WakeForNodeSettled tells the supervisor that a node's turn landed and its
// output is committed. The scheduler dispatches the node's input, but the next
// step after that node (a review, a follow-up turn, a decision) is main's job:
// without this fact a graph whose worker succeeded simply stops moving while
// every view still calls it "in progress".
func WakeForNodeSettled(store *TaskStore, taskID, nodeID, status, operationID string) bool {
	data := map[string]any{"graphId": taskID, "nodeId": nodeID, "status": status, "operationId": operationID}
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "node_settled", DedupeKey: taskID + ":" + nodeID + ":" + operationID, Data: data, HasData: true})
}

func WakeForHumanCheck(store *TaskStore, taskID string, data any) bool {
	m := asMap(data)
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "human_check", DedupeKey: mapString(m, "questionId", "QuestionID"), Data: data, HasData: true})
}

func WakeForTaskCompleted(store *TaskStore, taskID string, data any) bool {
	payload := map[string]any{}
	if m := asMap(data); m != nil && !sliceLike(data) {
		for k, v := range m {
			payload[k] = v
		}
	} else {
		payload["outcome"] = data
	}
	payload["graphId"] = taskID
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "task_completed", DedupeKey: taskID + ":completed", Data: payload, HasData: true})
}

func WakeForAnswer(store *TaskStore, taskID string, data any) bool {
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "answer", DedupeKey: mapString(asMap(data), "questionId", "QuestionID"), Data: data, HasData: true})
}

func WakeForWaiting(store *TaskStore, taskID string, data any) bool {
	return WakeMaster(store, WakeIntent{TaskID: taskID, Kind: "waiting", DedupeKey: mapString(asMap(data), "questionId", "QuestionID"), Data: data, HasData: true})
}

func sliceLike(v any) bool {
	if v == nil {
		return false
	}
	_, ok := v.([]any)
	if ok {
		return true
	}
	return asSlice(v) != nil && asMap(v) == nil
}

func PendingWakes(store *TaskStore, taskID, nodeID string) []PendingWake {
	rows := sqliteRows(store.DB, `SELECT id,task_id AS taskId,kind,dedupe_key AS dedupeKey,data
    FROM wake_intents WHERE task_id=? AND node_id=? AND state='ready' ORDER BY id`, taskID, nodeID)
	out := make([]PendingWake, 0, len(rows))
	for _, row := range rows {
		item := PendingWake{ID: sqlInt(row["id"]), TaskID: sqlString(row["taskId"]), Kind: WakeKind(sqlString(row["kind"])), DedupeKey: sqlString(row["dedupeKey"])}
		if row["data"] != nil {
			text := sqlString(row["data"])
			item.Data = &text
		}
		out = append(out, item)
	}
	return out
}

func ConsumeWake(store *TaskStore, taskID, nodeID, operationID, kind, dedupeKey string) int64 {
	return sqliteChanges(store.DB, "UPDATE wake_intents SET state='consumed',consumed_operation_id=? WHERE task_id=? AND node_id=? AND kind=? AND dedupe_key=? AND state='ready'",
		operationID, taskID, nodeID, kind, dedupeKey)
}

func ReleaseWakes(store *TaskStore, operationID string) int64 {
	return sqliteChanges(store.DB, "UPDATE wake_intents SET state='ready',consumed_operation_id=NULL WHERE consumed_operation_id=? AND state='consumed'", operationID)
}

// RenderWakes is what the master is told about why it is awake. One line per fact, oldest first.
func RenderWakes(wakes []PendingWake) string {
	lines := make([]string, 0, len(wakes))
	for _, wake := range wakes {
		data := map[string]any{}
		if wake.Data != nil && *wake.Data != "" {
			if parsed := asMap(parseJSON(*wake.Data)); parsed != nil {
				data = parsed
			}
		}
		switch wake.Kind {
		case "node_question":
			lines = append(lines, "- Node "+jsString(data["nodeId"])+" in graph "+jsString(data["graphId"])+" asked question "+jsString(data["questionId"])+". Use list_problems to inspect it and resolve it if you can.")
		case "supervisor_question":
			lines = append(lines, "- A project supervisor needs your help with question "+jsString(data["questionId"])+" at revision "+jsString(data["revision"])+". Use list_problems to inspect it, resolve what you can, and only ask the user if necessary.")
		case "work_draft_ready":
			lines = append(lines, "- Project supervisor saved graph draft "+jsString(data["version"])+" for work "+jsString(data["workId"])+" (work revision "+jsString(data["workRevision"])+", draft revision "+jsString(data["draftRevision"])+"). Use read_work_draft to inspect it and report to the user.")
		case "task_completed":
			graphID := jsString(coalesce(data["graphId"], wake.DedupeKey))
			phase := jsString(coalesce(data["phase"], "completed"))
			extra := ""
			if jsTruthy(data["integrationSha"]) {
				sha := jsString(data["integrationSha"])
				if len(sha) > 12 {
					sha = sha[:12]
				}
				extra = ", integration " + sha
			}
			lines = append(lines, "- Graph "+graphID+" finished (phase "+phase+extra+"). Read its outcome and report it to the user; nothing else is waiting on it.")
		case "graph_ready":
			lines = append(lines, "- Graph "+jsString(data["graphId"])+" is ready and awaits explicit input. Read graph_inspect revision, select the intended named input and use graph_send with a value satisfying its protocol. Confirmation did not enqueue any task.")
		case "graph_output":
			lines = append(lines, "- Graph "+jsString(data["graphId"])+" published output "+jsString(data["output"])+" (result "+jsString(data["resultId"])+"). Read graph_inspect results for its exact business value.")
		case "acceptance_blocked":
			lines = append(lines, "- Graph "+jsString(data["graphId"])+" is waiting for final evidence or Git delivery. Read graph_inspect acceptance and the delivery timeline; preserve the confirmed criteria and exact reviewed commit.")
		case "peer_message":
			lines = append(lines, "- Agent "+jsString(data["nodeId"])+" in graph "+jsString(data["graphId"])+" sent you a message. Read the pending conversation message and reply if needed.")
		case "task_stopped":
			lines = append(lines, "- Graph "+jsString(data["graphId"])+" stopped; its remaining work was cancelled.")
		case "node_settled":
			lines = append(lines, "- Node "+jsString(data["nodeId"])+" in graph "+jsString(data["graphId"])+" settled ("+jsString(coalesce(data["status"], "succeeded"))+") and its output is committed. Nobody else will start what comes next: read graph_inspect results for the exact value and start it yourself, or say why nothing should follow.")
		case "node_blocked":
			node := jsString(coalesce(data["nodeId"], wake.DedupeKey))
			where := ""
			if jsTruthy(data["graphId"]) {
				where = " in graph " + jsString(data["graphId"])
			}
			reason := jsString(coalesce(data["reason"], "blocked"))
			lines = append(lines, "- Node "+node+where+" needs your intervention ("+reason+"). Inspect its execution and decide whether to retry, skip, or change configuration; escalate only decisions that require the user.")
		case "answer":
			lines = append(lines, "- The user answered "+jsString(coalesce(data["kind"], "a question"))+" on node "+jsString(coalesce(data["nodeId"], "?"))+". Act on it so the graph can move on.")
		case "waiting":
			lines = append(lines, "- Node "+jsString(coalesce(data["nodeId"], "?"))+" is waiting on a decision only you can make.")
		case "human_check":
			lines = append(lines, "- A human acceptance check opened on node "+jsString(coalesce(data["nodeId"], "?"))+" and the user has not seen it yet. Look at the evidence: if it should not have been raised, send it back for rework; if it looks right, approve it so the user is asked with your review attached. Approving is not acceptance - the user still has to pass it themselves.")
		default:
			lines = append(lines, "- Graph event: "+string(wake.Kind)+" ("+wake.DedupeKey+").")
		}
	}
	return strings.Join(append([]string{"You were woken by the harness, not by the user: these facts happened while no turn was running."}, lines...), "\n")
}

func coalesce(v any, fallback any) any {
	if v == nil {
		return fallback
	}
	return v
}

func jsTruthy(v any) bool {
	switch t := v.(type) {
	case nil:
		return false
	case string:
		return t != ""
	case bool:
		return t
	case float64:
		return t != 0 && t == t
	case int64:
		return t != 0
	default:
		return true
	}
}

func jsString(v any) string {
	switch t := v.(type) {
	case nil:
		return "undefined"
	case string:
		return t
	case float64:
		if t == float64(int64(t)) {
			return strconv.FormatInt(int64(t), 10)
		}
		return strconv.FormatFloat(t, 'f', -1, 64)
	case int64:
		return strconv.FormatInt(t, 10)
	case int:
		return strconv.Itoa(t)
	case bool:
		if t {
			return "true"
		}
		return "false"
	default:
		return stringifyJSON(t)
	}
}
