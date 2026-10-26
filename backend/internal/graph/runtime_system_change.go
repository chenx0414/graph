package graph

import (
	"strings"
)

// SystemDiagnosticsInput is the scope the health view reports on.
type SystemDiagnosticsInput struct {
	Store          *TaskStore
	Catalog        *Catalog
	TaskIds        []string
	ConversationId string
}

// SystemDiagnostics is the health of one conversation.
func SystemDiagnostics(input SystemDiagnosticsInput) map[string]any {
	taskIds := []string{}
	for _, id := range input.TaskIds {
		if id != "" {
			taskIds = append(taskIds, id)
		}
	}
	scope := map[string]any{"conversationId": input.ConversationId, "taskIds": taskIds}
	pendingChanges := []any{}
	openProblems := []any{}
	failedNodes := []any{}
	unknownUsage := []any{}
	artifactStats := map[string]any{"artifacts": 0, "versions": 0, "bytes": 0, "published": 0}
	invalidCapabilities := []any{}
	capabilityCount := 0
	if len(taskIds) == 0 {
		return map[string]any{
			"scope": scope, "artifactWorkspace": map[string]any{"scope": "task"},
			"pendingSystemChanges": pendingChanges, "openInternalProblems": openProblems,
			"failedNodes": failedNodes, "unknownUsage": unknownUsage,
			"capabilityHealth": map[string]any{"total": 0, "invalid": invalidCapabilities},
		}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(taskIds)), ",")
	args := make([]any, 0, len(taskIds))
	for _, id := range taskIds {
		args = append(args, id)
	}
	questions := kernelRows(input.Store.Db, "SELECT id,task_id AS taskId,node_id AS nodeId,kind,owner,status,data,"+
		"(SELECT timestamp FROM events WHERE type='question.opened' AND json_extract(data,'$.questionId')=questions.id ORDER BY cursor DESC LIMIT 1) AS createdAt "+
		"FROM questions WHERE status='open' AND task_id IN ("+placeholders+") ORDER BY rowid DESC LIMIT 100", args...)
	for _, row := range questions {
		data := asMap(parseJSONDocumentOrNil(kernelString(row["data"])))
		if kernelString(row["kind"]) == "system_change" {
			change := asMap(data["change"])
			pendingChanges = append(pendingChanges, map[string]any{
				"questionId": kernelString(row["id"]), "taskId": kernelString(row["taskId"]), "nodeId": kernelString(row["nodeId"]),
				"proposalId": systemChangeString(data["proposalId"]), "title": systemChangeTitle(data["title"]),
				"problem": systemChangeProblem(data["problem"]), "changeKind": systemChangeString(change["kind"]),
			})
		}
		if kernelString(row["owner"]) == string(QuestionOwnerMain) {
			openProblems = append(openProblems, map[string]any{
				"questionId": kernelString(row["id"]), "taskId": kernelString(row["taskId"]), "nodeId": kernelString(row["nodeId"]),
				"kind": kernelString(row["kind"]), "data": data, "createdAt": kernelInt(row["createdAt"]),
			})
		}
	}
	for _, row := range kernelRows(input.Store.Db, "SELECT n.task_id AS taskId,n.id AS nodeId,n.status,t.request "+
		"FROM nodes n JOIN tasks t ON t.id=n.task_id WHERE n.status IN ('failed','blocked') AND n.task_id IN ("+placeholders+") "+
		"ORDER BY n.rowid DESC LIMIT 50", args...) {
		failedNodes = append(failedNodes, map[string]any{
			"taskId": kernelString(row["taskId"]), "nodeId": kernelString(row["nodeId"]),
			"status": kernelString(row["status"]), "request": kernelString(row["request"]),
		})
	}
	for _, row := range kernelRows(input.Store.Db, "SELECT task_id AS taskId,node_id AS nodeId,operation_id AS operationId "+
		"FROM questions WHERE kind='unknown_usage' AND status='open' AND task_id IN ("+placeholders+") "+
		"ORDER BY rowid DESC LIMIT 50", args...) {
		unknownUsage = append(unknownUsage, map[string]any{
			"taskId": kernelString(row["taskId"]), "nodeId": kernelString(row["nodeId"]),
			"operationId": kernelString(row["operationId"]),
		})
	}
	stats := kernelRow(input.Store.Db, "SELECT COUNT(*) AS versions, COUNT(DISTINCT artifact_id) AS artifacts, "+
		"COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE task_id IN ("+placeholders+")", args...)
	published := kernelRow(input.Store.Db, "SELECT COUNT(*) AS count FROM artifacts WHERE state='published' AND task_id IN ("+placeholders+")", args...)
	artifactStats = map[string]any{
		"scope": "task", "artifacts": kernelInt(stats["artifacts"]), "versions": kernelInt(stats["versions"]),
		"bytes": kernelInt(stats["bytes"]), "published": kernelInt(published["count"]),
	}
	if input.Catalog != nil {
		capabilities := input.Catalog.Capabilities()
		capabilityCount = len(capabilities)
		for _, capability := range capabilities {
			if capability.Status != "invalid" {
				continue
			}
			reason := capability.Error
			if reason == "" {
				reason = "invalid"
			}
			invalidCapabilities = append(invalidCapabilities, map[string]any{
				"id": capability.Id, "version": capability.Version, "error": reason,
			})
			if len(invalidCapabilities) >= 100 {
				break
			}
		}
	}
	return map[string]any{
		"scope":                scope,
		"artifactWorkspace":    artifactStats,
		"pendingSystemChanges": pendingChanges,
		"openInternalProblems": openProblems,
		"failedNodes":          failedNodes,
		"unknownUsage":         unknownUsage,
		"capabilityHealth":     map[string]any{"total": capabilityCount, "invalid": invalidCapabilities},
	}
}

// parseJSONDocumentOrNil reads one JSON document, or nil when it is not one.
func parseJSONDocumentOrNil(text string) any {
	parsed, ok := parseJSONDocument(text)
	if !ok {
		return nil
	}
	return parsed
}

// systemChangeString reads a string field, or an empty string.
func systemChangeString(value any) string {
	text, _ := value.(string)
	return text
}

// systemChangeTitle names a proposal that did not name itself.
func systemChangeTitle(value any) string {
	text := strings.TrimSpace(systemChangeString(value))
	if text == "" {
		return "未命名系统变更"
	}
	return text
}

// systemChangeProblem reads the problem statement of a proposal.
func systemChangeProblem(value any) string {
	text := systemChangeString(value)
	if len([]rune(text)) > 1000 {
		return string([]rune(text)[:1000])
	}
	return text
}

// SystemChangeProposal is one change the main Agent asks a person for.
type SystemChangeProposal struct {
	Title   string
	Problem string
	Change  map[string]any
	Impact  *string
	Risk    *string
}

// ProposeSystemChange turns a proposal into a question the user answers.
//
// A host that lets the Agent change itself without asking is a host that
// cannot be trusted to keep its promises, so the proposal is a question by
// default. Only a policy that says the Agent may act on its own answers it
// right away, and then the answer is on the record with the policy that made
// it.
func ProposeSystemChange(store *TaskStore, taskId, nodeId string, policy *ResolvedAccessPolicy, proposal SystemChangeProposal) map[string]any {
	proposalId := graphUUID()
	data := map[string]any{
		"proposalId": proposalId,
		"title":      proposal.Title,
		"problem":    proposal.Problem,
		"change":     proposal.Change,
		"prompt":     "系统优化待批准：" + proposal.Title,
	}
	if proposal.Impact != nil {
		data["impact"] = *proposal.Impact
	}
	if proposal.Risk != nil {
		data["risk"] = *proposal.Risk
	}
	autoApproved := policy != nil && policy.AutoApprove.SystemChange
	input := QuestionInput{TaskId: taskId, NodeId: nodeId, Kind: "system_change", Data: data}
	if autoApproved {
		input.AutoAnswer = &QuestionAutoAnswer{
			Answer:       Answer{Type: "respond", Value: map[string]any{"decision": "approved", "proposalId": proposalId}},
			PolicyDigest: policy.Digest,
		}
	}
	question := InsertQuestion(store, input)
	status := "awaiting_user_approval"
	instruction := "Stop after reporting the proposal. The user must approve it before apply_system_change can run."
	if autoApproved {
		status = "auto_approved"
		instruction = "Full access policy approved this proposal. Call apply_system_change now with this proposalId, then report the verified result."
	}
	return map[string]any{
		"proposalId": proposalId, "questionId": question.Id, "status": status, "instruction": instruction,
	}
}

// ApplySystemChange applies one approved proposal.
//
// An approved proposal is applied once: the receipt is on the timeline, so a
// second call with the same id reads the receipt back instead of installing
// the same capability twice.
func ApplySystemChange(store *TaskStore, catalog *Catalog, taskId, nodeId, proposalId string) map[string]any {
	applied := kernelRow(store.Db, "SELECT data FROM events WHERE type='system.change_applied' AND json_extract(data,'$.proposalId')=? ORDER BY cursor DESC LIMIT 1", proposalId)
	if applied != nil {
		record := asMap(parseJSONDocumentOrNil(kernelString(applied["data"])))
		if record != nil {
			return record
		}
	}
	row := kernelRow(store.Db, "SELECT id,task_id AS taskId,node_id AS nodeId,status,data,answer FROM questions "+
		"WHERE kind='system_change' AND json_extract(data,'$.proposalId')=? ORDER BY rowid DESC LIMIT 1", proposalId)
	if row == nil {
		Raise("not_found", "Unknown system-change proposal "+proposalId)
	}
	if kernelString(row["taskId"]) != taskId || kernelString(row["nodeId"]) != nodeId {
		Raise("approval_required", "The system-change proposal belongs to a different Main Agent instance")
	}
	if kernelString(row["status"]) != "resolved" || kernelString(row["answer"]) == "" {
		Raise("approval_required", "The system change has not been approved by the user")
	}
	answer := asMap(parseJSONDocumentOrNil(kernelString(row["answer"])))
	value := asMap(answer["value"])
	if kernelString(answer["type"]) != "respond" || kernelString(value["decision"]) != "approved" {
		Raise("approval_required", "The user did not approve this system change")
	}
	data := asMap(parseJSONDocumentOrNil(kernelString(row["data"])))
	change := asMap(data["change"])
	if change == nil || kernelString(change["kind"]) != "capability" {
		Raise("unsupported", "Only approved capability changes can be applied in this runtime")
	}
	capability := asMap(change["capability"])
	if capability == nil {
		Raise("invalid_input", "The approved capability change is missing its capability bundle")
	}
	if catalog == nil {
		Raise("unsupported", "This runtime has no writable capability catalog")
	}
	manifest := capability["manifest"]
	files := map[string]string{}
	if raw, ok := capability["files"].(map[string]any); ok {
		for name, body := range raw {
			text, isString := body.(string)
			if !isString {
				Raise("invalid_input", "The approved capability change carries a file that is not text")
			}
			files[name] = text
		}
	}
	overwrite := capability["overwrite"] == true
	result := catalog.UpsertCapabilityBundle(CapabilityBundleInput{Manifest: manifest, Files: files, Overwrite: overwrite})
	receipt := map[string]any{
		"proposalId": proposalId, "questionId": kernelString(row["id"]), "applied": true, "result": result,
	}
	store.Event(taskId, "system.change_applied", receipt)
	return receipt
}

// systemChangeScope is the tasks the health view reports on: the anchor task of
// the conversation and every task that belongs to it.
func systemChangeScope(store *TaskStore, conversation *ConversationRow, taskId string) []string {
	ids := []string{}
	if conversation.AnchorTaskId != "" {
		ids = append(ids, conversation.AnchorTaskId)
	}
	for _, row := range kernelRows(store.Db, "SELECT id FROM tasks WHERE conversation_id=?", conversation.Id) {
		id := kernelString(row["id"])
		if id == "" || containsString(ids, id) {
			continue
		}
		ids = append(ids, id)
	}
	if len(ids) == 0 && taskId != "" {
		ids = append(ids, taskId)
	}
	return ids
}
