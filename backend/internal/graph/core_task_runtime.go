package graph

import (
	"encoding/json"
	"regexp"
	"strings"
)

// THINKING_LEVELS is the vocabulary of thinking strengths the runtime accepts.
var THINKING_LEVELS = []string{"off", "minimal", "low", "medium", "high", "xhigh", "max"}

// DECISION_DIGEST_MAX_MESSAGES bounds the compatibility decision snapshot.
//
// When the master declares no decisions the harness freezes the conversation's
// consumed user messages instead. That is deliberate: it is how a constraint the
// user states in chat reaches the node doing the work. But it had no bound, so
// one real task carried 636 entries of its whole chat history into every node.
//
// The window keeps BOTH ends. Dropping the oldest instead would defeat the
// feature, because the original request and the constraints stated with it are
// the oldest messages there are.
const DECISION_DIGEST_MAX_MESSAGES = 20

// DECISION_DIGEST_HEAD is how many of the oldest messages the window keeps.
const DECISION_DIGEST_HEAD = 6

// DECISION_DIGEST_TAIL is how many of the newest messages the window keeps.
const DECISION_DIGEST_TAIL = DECISION_DIGEST_MAX_MESSAGES - DECISION_DIGEST_HEAD

// DECISION_DIGEST_MAX_CHARS bounds the frozen decision snapshot.
const DECISION_DIGEST_MAX_CHARS = 4_000

// StatesADecision reports whether a user message says anything worth carrying
// into every node's briefing.
//
// The fallback exists so a constraint the user states in chat reaches the
// worker, and that is exactly why it cannot be a length rule: "别动 login" is
// shorter than "好的，继续吧" and is the kind of line the fallback is for. What
// it can drop is a message that states no decision at all - a slash command, or
// a bare acknowledgement or continuation - because those cost window space in
// every briefing while reading like a constraint to a model that is looking for
// one (HB-190).
func StatesADecision(text string) bool {
	bare := strings.TrimSpace(text)
	bare = strings.TrimRight(bare, "。.!！？?，,、;；:： \t\r\n")
	bare = strings.TrimSpace(bare)
	if bare == "" {
		return false
	}
	if strings.HasPrefix(bare, "/") {
		return false
	}
	return !taskRuntimeDecisionPattern.MatchString(bare)
}

var taskRuntimeDecisionPattern = regexp.MustCompile(`(?i)^(?:continue|go on|ok(?:ay)?|yes|yep|thanks|thank you|继续|接着(?:做|干)?|好的|好|是|是的|对|可以|行|收到|谢谢|多谢)$`)

// taskRuntimeAsThinkingLevel validates one thinking level.
func taskRuntimeAsThinkingLevel(value string) string {
	for _, level := range THINKING_LEVELS {
		if level == value {
			return value
		}
	}
	Raise("invalid_input", "A valid thinking level is required")
	return ""
}

// taskRuntimeSteeringText renders one queued message as steering text.
func taskRuntimeSteeringText(row MessageRow) string {
	parts := []string{}
	if trimmed := strings.TrimSpace(row.Text); trimmed != "" {
		parts = append(parts, trimmed)
	}
	if row.Data != nil {
		var data map[string]any
		if err := json.Unmarshal([]byte(*row.Data), &data); err == nil {
			if attachments, ok := data["attachments"].([]any); ok {
				for _, value := range attachments {
					record, ok := jsonRecord(value)
					if !ok {
						continue
					}
					name, _ := record["name"].(string)
					if name == "" {
						continue
					}
					text, _ := record["text"].(string)
					if strings.TrimSpace(text) != "" {
						parts = append(parts, "附件 "+name+":\n"+text)
						continue
					}
					kind, _ := record["type"].(string)
					if kind == "" {
						kind = "image/png"
					}
					size := int64(0)
					if value, ok := record["size"].(float64); ok {
						size = int64(value)
					}
					attachment := AttachmentInput{Name: name, Type: kind, Size: size, Text: ""}
					if data, ok := record["data"].(string); ok {
						attachment.Data = &data
					}
					if IsImageAttachment(attachment) {
						// Steering is text-only today; keep the image visible by name
						// instead of silently dropping the reference.
						parts = append(parts, "附件 "+name+"（图片，请在发送消息中查看）")
					}
				}
			}
		}
	}
	return strings.Join(parts, "\n\n")
}

// taskRuntimeProposalRow is one stored proposal row.
type taskRuntimeProposalRow struct {
	Version            int
	RequirementVersion int
	Spec               string
	DecisionSnapshot   *string
	DraftRevision      int
	DraftDigest        *string
	ArchivedAt         *int64
	DeletedAt          *int64
}

// taskRuntimeProposalSummary is the short form of one proposal row.
type taskRuntimeProposalSummary struct {
	Version            int    `json:"version"`
	RequirementVersion int    `json:"requirementVersion"`
	Stale              bool   `json:"stale"`
	Summary            string `json:"summary"`
	Accepted           bool   `json:"accepted"`
	DraftRevision      int    `json:"draftRevision"`
	DraftDigest        string `json:"draftDigest"`
	Archived           bool   `json:"archived"`
}

// taskRuntimeProposalCards is the draft projection every formal read path shares.
type taskRuntimeProposalCards struct {
	Current           *taskRuntimeProposalSummary  `json:"current"`
	ProposalHistory   []taskRuntimeProposalSummary `json:"proposalHistory"`
	ArchivedProposals []taskRuntimeProposalSummary `json:"archivedProposals"`
}

func taskRuntimeProposalRows(store *TaskStore, taskId string) []taskRuntimeProposalRow {
	rows := kernelRows(store.Db, "SELECT version,requirement_version,spec,decision_snapshot,draft_revision,draft_digest,archived_at,deleted_at FROM proposals WHERE task_id=? ORDER BY version", taskId)
	out := make([]taskRuntimeProposalRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, taskRuntimeProposalRow{
			Version:            int(kernelInt(row["version"])),
			RequirementVersion: int(kernelInt(row["requirement_version"])),
			Spec:               kernelString(row["spec"]),
			DecisionSnapshot:   taskRuntimeOptionalText(row["decision_snapshot"]),
			DraftRevision:      int(kernelInt(row["draft_revision"])),
			DraftDigest:        taskRuntimeOptionalText(row["draft_digest"]),
			ArchivedAt:         taskRuntimeOptionalInt(row["archived_at"]),
			DeletedAt:          taskRuntimeOptionalInt(row["deleted_at"]),
		})
	}
	return out
}

func taskRuntimeOptionalText(value any) *string {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	return &text
}

func taskRuntimeOptionalInt(value any) *int64 {
	if value == nil {
		return nil
	}
	number := kernelInt(value)
	return &number
}

// taskRuntimeDraftProjection is the current draft card plus the management metadata.
func taskRuntimeDraftProjection(store *TaskStore, taskId string, task TaskRow) taskRuntimeProposalCards {
	rows := taskRuntimeProposalRows(store, taskId)
	formal := func(row taskRuntimeProposalRow) bool {
		return task.AcceptedProposal != nil && row.Version == int(*task.AcceptedProposal)
	}
	live := func(row taskRuntimeProposalRow) bool {
		return formal(row) || (row.DeletedAt == nil && row.ArchivedAt == nil)
	}
	summary := func(row taskRuntimeProposalRow) taskRuntimeProposalSummary {
		text := ""
		var spec map[string]any
		if err := json.Unmarshal([]byte(row.Spec), &spec); err == nil {
			if value, ok := spec["summary"].(string); ok {
				text = value
			}
		}
		digest := ContentDigest(row.Spec)
		if row.DraftDigest != nil {
			digest = *row.DraftDigest
		}
		return taskRuntimeProposalSummary{
			Version:            row.Version,
			RequirementVersion: row.RequirementVersion,
			Stale:              row.RequirementVersion != int(task.RequirementVersion),
			Summary:            text,
			Accepted:           formal(row),
			DraftRevision:      row.DraftRevision,
			DraftDigest:        digest,
			Archived:           row.ArchivedAt != nil,
		}
	}
	var current *taskRuntimeProposalSummary
	for _, row := range rows {
		if row.Version == int(task.LatestProposal) && live(row) {
			value := summary(row)
			current = &value
			break
		}
	}
	history := []taskRuntimeProposalSummary{}
	archived := []taskRuntimeProposalSummary{}
	for _, row := range rows {
		if !live(row) || formal(row) {
			continue
		}
		history = append(history, summary(row))
	}
	for _, row := range rows {
		if row.ArchivedAt == nil || row.DeletedAt != nil || formal(row) {
			continue
		}
		archived = append(archived, summary(row))
	}
	return taskRuntimeProposalCards{Current: current, ProposalHistory: history, ArchivedProposals: archived}
}

// taskRuntimeConversationProposal reads one proposal version of a conversation.
func taskRuntimeConversationProposal(store *TaskStore, taskId string, version int, currentRequirementVersion int, includeArchived bool) any {
	row := kernelRow(store.Db, "SELECT version,requirement_version,spec,decision_snapshot,draft_revision,draft_digest,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", taskId, version)
	if row == nil {
		return nil
	}
	if row["deleted_at"] != nil {
		return nil
	}
	if row["archived_at"] != nil && !includeArchived {
		return nil
	}
	var spec NativeProposal
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	digest := ContentDigest(kernelString(row["spec"]))
	if row["draft_digest"] != nil {
		digest = kernelString(row["draft_digest"])
	}
	archived := row["archived_at"] != nil
	var archivedAt any
	if row["archived_at"] != nil {
		archivedAt = kernelInt(row["archived_at"])
	}
	return map[string]any{
		"version":            kernelInt(row["version"]),
		"requirementVersion": kernelInt(row["requirement_version"]),
		"stale":              kernelInt(row["requirement_version"]) != int64(currentRequirementVersion),
		"spec":               spec,
		"decisions":          taskRuntimeOptionalText(row["decision_snapshot"]),
		"draftRevision":      kernelInt(row["draft_revision"]),
		"draftDigest":        digest,
		"archived":           archived,
		"archivedAt":         archivedAt,
	}
}

// taskRuntimeConversationTarget names the task a command may act on.
func taskRuntimeConversationTarget(store *TaskStore, supervisorTaskId string, requested *string, what string) string {
	if requested == nil || *requested == supervisorTaskId {
		return supervisorTaskId
	}
	self := kernelRow(store.Db, "SELECT conversation_id FROM tasks WHERE id=?", supervisorTaskId)
	target := kernelRow(store.Db, "SELECT conversation_id FROM tasks WHERE id=?", *requested)
	if target == nil || self == nil || self["conversation_id"] == nil ||
		kernelString(target["conversation_id"]) != kernelString(self["conversation_id"]) {
		Raise("invalid_input", what+" may only target a task of this conversation")
	}
	return *requested
}

// taskRuntimeMissingTaskNode is the error for a node the task does not have.
func taskRuntimeMissingTaskNode(kernel *KernelStore, taskId, nodeId string) {
	hint := ""
	revision := kernel.LatestRevision(taskId)
	if revision != nil {
		if _, ok := revision.Definition.Modules[nodeId]; ok {
			query := map[string]any{"graphId": taskId, "query": "operations"}
			hint = ". " + nodeId + " is a module; get_task_status selects Agent nodes. Read graph_inspect(" + CanonicalJSON(query) + ") for its state and results."
		}
	}
	Raise("not_found", "Task "+taskId+" has no node "+nodeId+hint)
}

// taskRuntimeStatusView is a compact projection of one task.
func taskRuntimeStatusView(store *TaskStore, kernel *KernelStore, taskId string, nodeId *string) map[string]any {
	task := store.Task(taskId)
	native := kernel.LatestRevision(taskId)
	nodes := []map[string]any{}
	if native != nil {
		for _, node := range kernel.ListNodes(taskId) {
			configured := native.Definition.Nodes[node.NodeId]
			execution := kernelRow(store.Db, "SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1", taskId, node.NodeId)
			actual := configured
			if execution != nil {
				revision := kernel.Revision(taskId, int(kernelInt(execution["revision_version"])))
				if revision != nil {
					if value, ok := revision.Definition.Nodes[node.NodeId]; ok {
						actual = value
					}
				}
			}
			binding := kernelRow(store.Db, "SELECT model_id FROM kernel_node_bindings WHERE task_id=? AND node_id=?", taskId, node.NodeId)
			var model any
			if binding != nil && binding["model_id"] != nil {
				model = kernelString(binding["model_id"])
			}
			nodes = append(nodes, map[string]any{
				"id":                 node.NodeId,
				"spec":               CanonicalJSON(map[string]any{"kind": "agent", "action": actual.Task}),
				"status":             node.Status,
				"stall_count":        0,
				"model":              model,
				"definition_version": actual.Recipe,
			})
		}
	} else {
		for _, row := range kernelRows(store.Db, `SELECT n.id,n.spec,n.status,n.stall_count,i.model,i.definition_version
    FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid`, taskId) {
			nodes = append(nodes, map[string]any{
				"id":                 kernelString(row["id"]),
				"spec":               kernelString(row["spec"]),
				"status":             kernelString(row["status"]),
				"stall_count":        kernelInt(row["stall_count"]),
				"model":              row["model"],
				"definition_version": row["definition_version"],
			})
		}
	}
	selected := nodes
	if nodeId != nil {
		selected = []map[string]any{}
		for _, row := range nodes {
			if row["id"] == *nodeId {
				selected = append(selected, row)
			}
		}
		if len(selected) == 0 {
			taskRuntimeMissingTaskNode(kernel, taskId, *nodeId)
		}
	}
	questions := kernelRows(store.Db, "SELECT id,node_id,kind,owner FROM questions WHERE task_id=? AND status='open' ORDER BY rowid", taskId)
	evidence := kernelRows(store.Db, "SELECT node_id,data,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid", taskId)
	current := map[string]map[string]any{}
	order := []string{}
	for _, row := range evidence {
		var data map[string]any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		acceptanceId, _ := data["acceptanceId"].(string)
		entry := map[string]any{
			"acceptanceId": acceptanceId,
			"nodeId":       kernelString(row["node_id"]),
			"valid":        kernelInt(row["valid"]) != 0,
		}
		if row["commit_sha"] != nil {
			entry["commitSha"] = kernelString(row["commit_sha"])
		}
		if _, ok := current[acceptanceId]; !ok {
			order = append(order, acceptanceId)
		}
		current[acceptanceId] = entry
	}
	userQuestions := []map[string]any{}
	problems := []map[string]any{}
	for _, question := range questions {
		entry := map[string]any{
			"id":     kernelString(question["id"]),
			"nodeId": kernelString(question["node_id"]),
			"kind":   kernelString(question["kind"]),
		}
		if kernelString(question["owner"]) == "user" {
			userQuestions = append(userQuestions, entry)
		} else {
			problems = append(problems, entry)
		}
	}
	status := task.Phase
	if task.Paused != 0 {
		if native != nil && KernelHasActiveWork(kernel, taskId) {
			status = "pausing"
		} else {
			status = "paused"
		}
	} else if len(userQuestions) > 0 {
		status = "blocked"
	}
	graphVersion := task.GraphVersion
	if native != nil {
		graphVersion = int64(native.Version)
	}
	selectedNodes := []map[string]any{}
	for _, row := range selected {
		var spec NodeSpec
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
			panic(err)
		}
		model := row["model"]
		if row["status"] == "pending" {
			model = spec.Model
			if model == nil {
				model = row["model"]
			}
		} else if row["model"] == nil {
			model = spec.Model
		}
		entry := map[string]any{
			"id":     row["id"],
			"kind":   spec.Kind,
			"action": spec.Action,
			"status": row["status"],
		}
		if model != nil {
			entry["model"] = model
		}
		if row["definition_version"] != nil {
			entry["definition"] = row["definition_version"]
		}
		if kernelInt(row["stall_count"]) != 0 {
			entry["stallCount"] = kernelInt(row["stall_count"])
		}
		if nodeId != nil {
			if native != nil {
				entry["configuration"] = native.Definition.Nodes[spec.Id]
			} else {
				entry["input"] = spec.Input
			}
		}
		selectedNodes = append(selectedNodes, entry)
	}
	evidenceList := []map[string]any{}
	for _, acceptanceId := range order {
		evidenceList = append(evidenceList, current[acceptanceId])
	}
	return map[string]any{
		"taskId":                  taskId,
		"phase":                   task.Phase,
		"status":                  status,
		"graphVersion":            graphVersion,
		"proposalVersion":         task.LatestProposal,
		"acceptedProposalVersion": task.AcceptedProposal,
		"targetBranch":            task.TargetBranch,
		"integrationSha":          task.IntegrationSha,
		"nodes":                   selectedNodes,
		"questions":               userQuestions,
		"problems":                problems,
		"evidence":                evidenceList,
	}
}
