package graph

import (
	"encoding/json"
	"strings"
)

// AcceptanceStatus is one criterion's evidence.
type AcceptanceStatus struct {
	Id          string            `json:"id"`
	Description string            `json:"description"`
	Kind        string            `json:"kind"`
	Status      string            `json:"status"`
	Reason      string            `json:"reason"`
	Source      *AcceptanceSource `json:"source,omitempty"`
}

// AcceptanceSource names the row or artifact that decided a criterion.
type AcceptanceSource struct {
	Id      string  `json:"id"`
	Version *int    `json:"version,omitempty"`
	Commit  *string `json:"commit,omitempty"`
}

// GraphAcceptanceReport is the final acceptance of one graph.
type GraphAcceptanceReport struct {
	Ready    bool                    `json:"ready"`
	Drained  bool                    `json:"drained"`
	Commit   *string                 `json:"commit"`
	Items    []AcceptanceStatus      `json:"items"`
	Human    []AcceptanceCriterion   `json:"human"`
	Delivery GraphAcceptanceDelivery `json:"delivery"`
}

// GraphAcceptanceDelivery is the Git receipt, when one is required.
type GraphAcceptanceDelivery struct {
	Required bool    `json:"required"`
	Commit   *string `json:"commit"`
}

func graphAcceptanceObject(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok
}

func graphAcceptanceReportBytes(artifacts *ArtifactWorkspace, graphID, artifactID string, version int) map[string]any {
	if artifacts == nil {
		return nil
	}
	defer func() { _ = recover() }()
	raw := artifacts.ReadVerifiedContent(graphID, artifactID, version)
	parsed := g5JSON(string(raw))
	record, ok := graphAcceptanceObject(parsed)
	if !ok {
		return nil
	}
	return record
}

// graphAcceptanceCommitEqual mirrors TypeScript equality between a JSON value
// and a commit that is string | null. A missing key is undefined, and
// undefined never equals null, so presence is part of the comparison.
func graphAcceptanceCommitEqual(value any, present bool, commit *string) bool {
	if !present {
		return false
	}
	if value == nil {
		return commit == nil
	}
	text, ok := value.(string)
	if !ok {
		return false
	}
	if commit == nil {
		return false
	}
	return text == *commit
}

// graphAcceptanceCommitText is the commit as text. A null commit is empty,
// which is how TypeScript tests it for truthiness.
func graphAcceptanceCommitText(commit *string) string {
	if commit == nil {
		return ""
	}
	return *commit
}

// graphAcceptanceShaEqual compares two nullable commits by value. TypeScript
// compares string | null with ===, so two nulls are equal and a null never
// equals a string.
func graphAcceptanceShaEqual(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

// graphAcceptanceHasKey reports whether a decoded JSON object carries a key.
// TypeScript distinguishes a missing key (undefined) from a null value.
func graphAcceptanceHasKey(record map[string]any, key string) bool {
	if record == nil {
		return false
	}
	_, ok := record[key]
	return ok
}

// graphAcceptanceIdentity is a decoded model identity as text. An identity that
// is not a string is absent, because TypeScript compares parsed values with ===
// and two separately parsed objects are never the same object.
func graphAcceptanceIdentity(value any) *string {
	text, ok := value.(string)
	if !ok {
		return nil
	}
	return &text
}

func graphAcceptanceIdentityEqual(left, right *string) bool {
	if left == nil || right == nil {
		return false
	}
	return *left == *right
}

// GraphAcceptance reads operation, publication, and actual-send records.
func GraphAcceptance(kernel *KernelStore, graphID string, artifacts *ArtifactWorkspace) GraphAcceptanceReport {
	task := kernel.Store.Task(graphID)
	definition := kernel.LatestRevision(graphID).Definition
	criteria := definition.Acceptance
	commit := task.IntegrationSha
	commitText := graphAcceptanceCommitText(commit)
	hasIntegrationBranch := task.IntegrationBranch != nil && *task.IntegrationBranch != ""
	items := []AcceptanceStatus{}
	human := []AcceptanceCriterion{}
	fail := func(id, reason string) {
		items = append(items, AcceptanceStatus{Id: id, Description: reason, Kind: "constraint", Status: "missing", Reason: reason})
	}
	hasKind := func(kind string) bool {
		for _, item := range criteria {
			if item.Kind == kind {
				return true
			}
		}
		return false
	}
	if hasIntegrationBranch && !hasKind("check") {
		fail("host-check", "Git delivery requires declared host checks")
	}
	if hasIntegrationBranch && commitText == "" {
		fail("integration-version", "Current integration commit is unavailable")
	}
	changed := hasIntegrationBranch && !graphAcceptanceShaEqual(task.TargetSha, commit)
	if changed && !hasKind("review") {
		fail("independent-review", "Code changes require declared independent review, and this confirmed acceptance declares none: a confirmed acceptance cannot be amended, so add a review criterion and re-confirm before delivering code")
	}
	if task.AcceptedProposal != nil && *task.AcceptedProposal != 0 {
		row, ok := g5One(kernel.Db, "SELECT spec FROM proposals WHERE task_id=? AND version=?", graphID, *task.AcceptedProposal)
		if !ok {
			fail("confirmed-acceptance", "Confirmed requirements are unavailable")
		} else {
			var confirmed NativeProposal
			if err := json.Unmarshal([]byte(g5Str(row["spec"])), &confirmed); err != nil {
				panic(err)
			}
			if int64(confirmed.RequirementVersion) != task.RequirementVersion {
				fail("requirement-version", "Confirmed requirements no longer match this task version")
			}
			for _, required := range confirmed.Acceptance {
				var declared *AcceptanceCriterion
				for i := range criteria {
					if criteria[i].Id == required.Id {
						declared = &criteria[i]
						break
					}
				}
				var original *AcceptanceCriterion
				for i := range confirmed.Definition.Acceptance {
					if confirmed.Definition.Acceptance[i].Id == required.Id {
						original = &confirmed.Definition.Acceptance[i]
						break
					}
				}
				preserved := false
				if original != nil {
					preserved = declared != nil && CanonicalJSON(*declared) == CanonicalJSON(*original)
				} else if declared != nil && declared.Description == required.Description {
					module, exists := definition.Modules[required.CheckNode]
					if exists && module.Type == "operation" {
						preserved = declared.Kind == "check" && declared.Module == required.CheckNode
					} else {
						preserved = declared.Kind == "review" && declared.Node == required.CheckNode
					}
				}
				if !preserved {
					fail(required.Id, "Confirmed acceptance must be preserved in the graph definition")
				}
			}
		}
	}
	calls := kernel.ProviderCalls(graphID)
	for _, criterion := range criteria {
		result := AcceptanceStatus{Id: criterion.Id, Description: criterion.Description, Kind: criterion.Kind, Status: "missing", Reason: "No valid evidence"}
		switch criterion.Kind {
		case "check":
			row, ok := g5One(kernel.Db, "SELECT id,state,request,result FROM kernel_module_operations WHERE task_id=? AND module_id=? ORDER BY rowid DESC LIMIT 1", graphID, criterion.Module)
			if ok {
				result.Source = &AcceptanceSource{Id: g5Str(row["id"])}
				if g5Str(row["state"]) != "settled" || row["result"] == nil {
					result.Reason = "Host check is " + g5Str(row["state"])
				} else {
					evaluated, _ := kernel.Content.Decode(g5Str(row["result"])).(map[string]any)
					outputs, _ := evaluated["outputs"].(map[string]any)
					operation := definition.Modules[criterion.Module].Operation
					output, _ := outputs[operation.Output].(map[string]any)
					recorded, _ := kernel.Content.Decode(g5Str(row["request"])).(map[string]any)
					if CanonicalJSON(recorded["operation"]) != CanonicalJSON(operation) {
						result.Status = "stale"
						result.Reason = "Host check used another operation configuration"
					} else if passed, _ := output["passed"].(bool); !passed {
						result.Status = "failed"
						result.Reason = "Host check did not pass"
					} else if commitText != "" && !graphAcceptanceCommitEqual(output["verifiedCommit"], graphAcceptanceHasKey(output, "verifiedCommit"), commit) {
						result.Status = "stale"
						result.Reason = "Host check does not verify the current clean commit"
					} else {
						result.Status = "passed"
						result.Reason = "Host check passed"
						result.Source.Commit = commit
					}
				}
			}
		case "review":
			row, ok := g5One(kernel.Db, `SELECT a.artifact_id,a.version,a.producer_operation_id
        FROM artifacts a JOIN kernel_executions x ON x.id=a.producer_operation_id AND x.task_id=a.task_id AND x.node_id=a.producer_node_id
        WHERE a.task_id=? AND a.scope='task' AND a.state='published' AND a.producer_node_id=? AND x.state='completed'
          AND a.schema_kind='graph.review' AND a.schema_version=1 ORDER BY a.created_at DESC,a.rowid DESC LIMIT 1`, graphID, criterion.Node)
			if ok {
				version := int(g5Int(row["version"]))
				result.Source = &AcceptanceSource{Id: g5Str(row["artifact_id"]), Version: &version}
				value := graphAcceptanceReportBytes(artifacts, graphID, g5Str(row["artifact_id"]), version)
				execution := kernel.Execution(g5Str(row["producer_operation_id"]))
				recipe := ""
				if revision := kernel.Revision(graphID, execution.RevisionVersion); revision != nil {
					recipe = revision.Definition.Nodes[criterion.Node].Recipe
				}
				reviewers := []KernelProviderCall{}
				unknown := false
				implementers := []KernelProviderCall{}
				for _, call := range calls {
					if call.Model == nil || call.Model.Recipe == nil {
						unknown = true
					}
					if call.ExecutionId == execution.Id {
						reviewers = append(reviewers, call)
					}
					if call.Model != nil && call.Model.Recipe != nil && call.Model.Recipe.Review == false {
						implementers = append(implementers, call)
					}
				}
				independent := len(reviewers) > 0
				for _, call := range reviewers {
					matched := call.Model != nil && call.Model.Recipe != nil && call.Model.Recipe.Review && call.Model.Recipe.Definition == recipe && (call.State == "settled" || call.State == "reconciled")
					if matched {
						for _, work := range implementers {
							if work.Model.Id == call.Model.Id || graphAcceptanceIdentityEqual(graphAcceptanceIdentity(work.Model.Identity), graphAcceptanceIdentity(call.Model.Identity)) {
								matched = false
							}
						}
					}
					if !matched {
						independent = false
					}
				}
				reason, _ := value["reason"].(string)
				passed, passedOK := value["passed"].(bool)
				if value == nil || !passedOK || strings.TrimSpace(reason) == "" {
					result.Reason = "Published review bytes are invalid"
				} else if !graphAcceptanceCommitEqual(value["commit"], graphAcceptanceHasKey(value, "commit"), commit) {
					result.Status = "stale"
					result.Reason = "Review concerns another commit"
				} else if !passed {
					result.Status = "failed"
					result.Reason = reason
				} else if unknown || !independent {
					result.Reason = "Actual reviewer model and independent recipe history are not proven"
				} else {
					result.Status = "passed"
					result.Reason = reason
					result.Source.Commit = commit
				}
			}
		default:
			rows := g5Query(kernel.Db, "SELECT id,data,answer FROM questions WHERE task_id=? AND kind='human_check' AND status='resolved' ORDER BY rowid DESC", graphID)
			var latest map[string]any
			for _, row := range rows {
				data, _ := g5JSON(g5Str(row["data"])).(map[string]any)
				if g5Str(data["acceptanceId"]) == criterion.Id && graphAcceptanceCommitEqual(data["commitSha"], graphAcceptanceHasKey(data, "commitSha"), commit) {
					latest = row
					break
				}
			}
			answerType := ""
			if latest != nil && latest["answer"] != nil {
				answer, _ := g5JSON(g5Str(latest["answer"])).(map[string]any)
				answerType, _ = answer["type"].(string)
			}
			if answerType == "acknowledge" {
				result.Status = "passed"
				result.Reason = "User accepted this version"
				result.Source = &AcceptanceSource{Id: g5Str(latest["id"]), Commit: commit}
			} else {
				result.Reason = "User acceptance is required for this version"
				human = append(human, criterion)
			}
		}
		items = append(items, result)
	}
	_, pending := g5One(kernel.Db, `SELECT 1 WHERE
    EXISTS(SELECT 1 FROM kernel_queue WHERE task_id=? AND state IN ('queued','claimed','failed')) OR
    EXISTS(SELECT 1 FROM kernel_executions WHERE task_id=? AND state='running') OR
    EXISTS(SELECT 1 FROM kernel_node_state WHERE task_id=? AND paused=1) OR
    EXISTS(SELECT 1 FROM kernel_module_inbox WHERE task_id=? AND processed=0) OR
    EXISTS(SELECT 1 FROM kernel_transition_outbox o JOIN kernel_module_transitions t ON t.id=o.transition_id WHERE t.task_id=? AND o.routed=0) OR
    EXISTS(SELECT 1 FROM questions WHERE task_id=? AND status='open') OR
    -- An unknown provider call is a hold only where it really is one. For a native node with no
    -- authorized budget the documented rule is the opposite: keep usage null and the unknown cost,
    -- and still allow later requests and workspace_commit (docs/agent/graph-v2.md). Counting those
    -- as pending pins such a graph in blocked forever: on 2026-09-27 an accepted graph whose only
    -- debt was 40 interrupted calls could never be delivered, while the harness raised no
    -- unknown_usage question for any of them, proof it never treated them as a hold. The native
    -- ledger is kernel_node_state.authorized_budget (null or 0 = no explicit cap = unlimited), not
    -- the legacy instances table, which holds master instances only. Inflight still blocks: a model
    -- call that is really running is not a drained graph.
    EXISTS(SELECT 1 FROM kernel_provider_calls c
             LEFT JOIN kernel_node_state s ON s.task_id=c.task_id AND s.node_id=c.node_id
            WHERE c.task_id=? AND (c.state='inflight' OR (c.state='unknown' AND COALESCE(s.authorized_budget,0) <> 0)))`,
		graphID, graphID, graphID, graphID, graphID, graphID, graphID)
	passed := true
	for _, item := range items {
		if item.Status != "passed" {
			passed = false
		}
	}
	receipt, ok := g5One(kernel.Db, "SELECT commit_sha FROM kernel_completion_delivery WHERE task_id=?", graphID)
	var delivered *string
	if ok && receipt["commit_sha"] != nil {
		text := g5Str(receipt["commit_sha"])
		delivered = &text
	}
	return GraphAcceptanceReport{
		Ready: !pending && task.Paused == 0 && passed, Drained: !pending, Commit: commit, Items: items, Human: human,
		Delivery: GraphAcceptanceDelivery{Required: hasIntegrationBranch, Commit: delivered},
	}
}
