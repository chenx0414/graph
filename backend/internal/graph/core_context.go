package graph

import (
	"encoding/hex"
	"encoding/json"
	"regexp"
	"strings"

	"crypto/sha256"
)

var contextDigestPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

type ResolveAgentContextInput struct {
	TaskId string
	NodeId string
	Spec   NodeSpec
}

type FreezeContextHandoffInput struct {
	TaskId           string
	OperationId      string
	NodeId           string
	InstanceId       string
	Package          ContextHandoffPackage
	CapabilityDigest *string
}

type ContextFacts struct {
	InitialMode         AgentContextMode `json:"initialMode"`
	SelectedMode        AgentContextMode `json:"selectedMode"`
	Purpose             *string          `json:"purpose"`
	RequestedFacts      any              `json:"requestedFacts"`
	Independence        *string          `json:"independence"`
	ReasonCode          *string          `json:"reasonCode"`
	SourceNodeId        *string          `json:"sourceNodeId"`
	SourceInstanceId    *string          `json:"sourceInstanceId"`
	SourceSessionId     *string          `json:"sourceSessionId"`
	SourceSessionFile   *string          `json:"sourceSessionFile"`
	SourceLeafId        *string          `json:"sourceLeafId"`
	SourceContextDigest *string          `json:"sourceContextDigest"`
	ChildContextDigest  *string          `json:"childContextDigest"`
	CapabilityDigest    *string          `json:"capabilityDigest"`
	ModelPolicyDigest   *string          `json:"modelPolicyDigest"`
	ToolPolicyDigest    *string          `json:"toolPolicyDigest"`
	ConstraintsDigest   *string          `json:"constraintsDigest"`
	ReviewPolicy        any              `json:"reviewPolicy"`
	HandoffDigest       *string          `json:"handoffDigest"`
	HandoffSummary      *string          `json:"handoffSummary"`
	BudgetScope         *BudgetScopeView `json:"budgetScope"`
}

func contextDigest(value any) string {
	text, ok := value.(string)
	if !ok {
		text = CanonicalJSON(value)
	}
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

func ResolveAgentContext(store *TaskStore, input ResolveAgentContextInput) ResolvedAgentContext {
	if input.Spec.Role == nil || *input.Spec.Role != "master" {
		Raise("context_rejected", "Legacy graph context is retired; graph nodes receive explicit interface deliveries")
	}
	instance := contextInstanceRow(store, input.TaskId, input.NodeId)
	if instance == nil {
		Raise("invalid_adapter", "Main context requires an instance")
	}
	existing := contextBindingRow(store, instance.Id)
	mode := AgentContextFresh
	reason := "default_fresh"
	if instance.SessionId != nil && *instance.SessionId != "" {
		mode = AgentContextContinue
		reason = "existing_session"
	}
	context := ResolvedAgentContext{
		Mode:              mode,
		Purpose:           ContextPurposeDiscuss,
		Independence:      ContextIndependenceNone,
		RequestedFacts:    []ContextFactRef{},
		ReasonCode:        reason,
		BindingId:         graphUUID(),
		ResolutionId:      graphUUID(),
		HandoffId:         graphUUID(),
		HandoffDigest:     "",
		ConstraintsDigest: "",
	}
	if existing != nil {
		context.BindingId = existing.Id
		context.BudgetScopeId = existing.BudgetScopeId
	} else {
		context.BudgetScopeId = EnsureBudgetScope(store, input.TaskId, instance.Id)
	}
	return context
}

func HandoffConstraintsDigest(handoff ContextHandoffPackage) string {
	return contextDigest(map[string]any{
		"acceptance":   handoff.Acceptance,
		"decisions":    handoff.Decisions,
		"outputSchema": handoff.OutputSchema,
	})
}

func FreezeContextHandoff(store *TaskStore, context ResolvedAgentContext, input FreezeContextHandoffInput) ResolvedAgentContext {
	validateContextHandoffPackage(context, input.Package)
	packageDigest := contextDigest(input.Package)
	constraintsDigest := HandoffConstraintsDigest(input.Package)
	existingBinding := contextBindingRow(store, input.InstanceId)
	if context.Mode != AgentContextFresh && context.Mode != AgentContextContinue {
		Raise("context_rejected", "Transcript inheritance is retired")
	}
	mode := "fresh"
	if existingBinding == nil {
		kernelExec(store.Db, `INSERT INTO agent_context_bindings(id,task_id,node_id,instance_id,mode,source_instance_id,
        source_session_id,source_session_file,source_leaf_id,budget_scope_id,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
			context.BindingId, input.TaskId, input.NodeId, input.InstanceId, mode,
			nil, nil, nil,
			context.SourceLeafId, context.BudgetScopeId, NowMillis())
	}
	version := kernelInt(kernelRow(store.Db, "SELECT COALESCE(MAX(version),0)+1 AS version FROM context_handoffs WHERE task_id=?", input.TaskId)["version"])
	kernelExec(store.Db, `INSERT INTO context_handoffs(id,task_id,operation_id,version,purpose,summary,package,digest,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`,
		context.HandoffId, input.TaskId, input.OperationId, version, string(context.Purpose), input.Package.Summary,
		CanonicalJSON(input.Package), packageDigest, NowMillis())
	kernelExec(store.Db, `INSERT INTO context_resolutions(id,task_id,node_id,operation_id,requested_purpose,requested_facts,independence,
      selected_mode,reason_code,source_instance_id,binding_id,handoff_id,constraints_digest,review_policy,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		context.ResolutionId, input.TaskId, input.NodeId, input.OperationId, string(context.Purpose),
		CanonicalJSON(context.RequestedFacts), string(context.Independence),
		string(context.Mode), context.ReasonCode, nil, context.BindingId, context.HandoffId,
		constraintsDigest, contextReviewPolicy(context),
		NowMillis())
	if input.CapabilityDigest != nil && *input.CapabilityDigest != "" {
		kernelExec(store.Db, "UPDATE agent_context_bindings SET capability_digest=? WHERE id=?", *input.CapabilityDigest, context.BindingId)
	}
	context.HandoffDigest = packageDigest
	context.ConstraintsDigest = constraintsDigest
	return context
}

func RecordContextSession(store *TaskStore, input PiAdapterContextSession) {
	resolution := kernelRow(store.Db, "SELECT selected_mode FROM context_resolutions WHERE operation_id=?", input.OperationId)
	kernelExec(store.Db, `UPDATE agent_context_bindings SET
      source_leaf_id=COALESCE(?,source_leaf_id),
      source_context_digest=COALESCE(?,source_context_digest),
      child_context_digest=COALESCE(?,child_context_digest),
      capability_digest=COALESCE(?,capability_digest),
      model_policy_digest=COALESCE(?,model_policy_digest),
      tool_policy_digest=COALESCE(?,tool_policy_digest)
    WHERE id=?`,
		contextOptionalText(input.SourceLeafId),
		contextOptionalText(input.SourceContextDigest),
		contextOptionalText(input.ChildContextDigest),
		contextOptionalText(contextOptionalStringValue(input.CapabilityDigest)),
		contextOptionalText(contextOptionalStringValue(input.ModelPolicyDigest)),
		contextOptionalText(contextOptionalStringValue(input.ToolPolicyDigest)),
		input.BindingId)
	if resolution != nil && kernelString(resolution["selected_mode"]) == string(AgentContextContinue) {
		store.Event(input.TaskId, "context.branch_resumed", map[string]any{
			"nodeId":              input.NodeId,
			"operationId":         input.OperationId,
			"bindingId":           input.BindingId,
			"sessionId":           contextOptionalText(contextOptionalStringValue(input.SessionId)),
			"sourceLeafId":        contextOptionalText(input.SourceLeafId),
			"sourceContextDigest": contextOptionalText(input.SourceContextDigest),
			"childContextDigest":  contextOptionalText(input.ChildContextDigest),
		})
	}
}

func ContextView(store *TaskStore, taskId, nodeId string) *ContextFacts {
	row := kernelRow(store.Db, `SELECT b.mode,b.source_instance_id,b.source_session_id,b.source_session_file,b.source_leaf_id,
      b.source_context_digest,b.child_context_digest,b.capability_digest,b.model_policy_digest,b.tool_policy_digest,
      b.budget_scope_id,b.created_at,
      r.selected_mode,r.requested_purpose,r.requested_facts,r.independence,r.reason_code,r.operation_id,
      r.constraints_digest,r.review_policy,
      h.digest AS handoff_digest,h.summary AS handoff_summary,h.package AS handoff_package,
      si.node_id AS source_node_id
    FROM instances i
    LEFT JOIN agent_context_bindings b ON b.instance_id=i.id
    LEFT JOIN context_resolutions r ON r.id=(SELECT id FROM context_resolutions WHERE binding_id=b.id ORDER BY created_at DESC,rowid DESC LIMIT 1)
    LEFT JOIN context_handoffs h ON h.id=(SELECT id FROM context_handoffs WHERE operation_id=r.operation_id ORDER BY rowid DESC LIMIT 1)
    LEFT JOIN instances si ON si.id=b.source_instance_id
    WHERE i.task_id=? AND i.node_id=?`, taskId, nodeId)
	if row == nil || kernelString(row["mode"]) == "" {
		return nil
	}
	mode := AgentContextMode(kernelString(row["mode"]))
	selected := mode
	if row["selected_mode"] != nil {
		selected = AgentContextMode(kernelString(row["selected_mode"]))
	}
	requestedFacts := any([]any{})
	if row["requested_facts"] != nil {
		requestedFacts = contextParseJSON(kernelString(row["requested_facts"]))
	}
	var reviewPolicy any
	if row["review_policy"] != nil {
		reviewPolicy = contextParseJSON(kernelString(row["review_policy"]))
	}
	var budgetScope *BudgetScopeView
	if row["budget_scope_id"] != nil {
		budgetScope = BudgetScopeViewOf(store, kernelString(row["budget_scope_id"]))
	}
	return &ContextFacts{
		InitialMode:         mode,
		SelectedMode:        selected,
		Purpose:             contextOptionalString(row["requested_purpose"]),
		RequestedFacts:      requestedFacts,
		Independence:        contextOptionalString(row["independence"]),
		ReasonCode:          contextOptionalString(row["reason_code"]),
		SourceNodeId:        contextOptionalString(row["source_node_id"]),
		SourceInstanceId:    contextOptionalString(row["source_instance_id"]),
		SourceSessionId:     contextOptionalString(row["source_session_id"]),
		SourceSessionFile:   contextOptionalString(row["source_session_file"]),
		SourceLeafId:        contextOptionalString(row["source_leaf_id"]),
		SourceContextDigest: contextOptionalString(row["source_context_digest"]),
		ChildContextDigest:  contextOptionalString(row["child_context_digest"]),
		CapabilityDigest:    contextOptionalString(row["capability_digest"]),
		ModelPolicyDigest:   contextOptionalString(row["model_policy_digest"]),
		ToolPolicyDigest:    contextOptionalString(row["tool_policy_digest"]),
		ConstraintsDigest:   contextOptionalString(row["constraints_digest"]),
		ReviewPolicy:        reviewPolicy,
		HandoffDigest:       contextOptionalString(row["handoff_digest"]),
		HandoffSummary:      contextOptionalString(row["handoff_summary"]),
		BudgetScope:         budgetScope,
	}
}

type contextInstance struct {
	Id            string
	BudgetScopeId *string
	SessionId     *string
}

func contextInstanceRow(store *TaskStore, taskId, nodeId string) *contextInstance {
	row := kernelRow(store.Db, `SELECT i.id,i.budget_scope_id,s.session_id
    FROM instances i LEFT JOIN node_sessions s ON s.instance_id=i.id
    WHERE i.task_id=? AND i.node_id=?`, taskId, nodeId)
	if row == nil {
		return nil
	}
	return &contextInstance{
		Id:            kernelString(row["id"]),
		BudgetScopeId: contextOptionalString(row["budget_scope_id"]),
		SessionId:     contextOptionalString(row["session_id"]),
	}
}

type contextBinding struct {
	Id            string
	BudgetScopeId string
}

func contextBindingRow(store *TaskStore, instanceId string) *contextBinding {
	row := kernelRow(store.Db, "SELECT id,budget_scope_id FROM agent_context_bindings WHERE instance_id=?", instanceId)
	if row == nil {
		return nil
	}
	return &contextBinding{Id: kernelString(row["id"]), BudgetScopeId: kernelString(row["budget_scope_id"])}
}

func validateContextHandoffPackage(context ResolvedAgentContext, handoff ContextHandoffPackage) {
	if handoff.Mode != context.Mode || handoff.Purpose != context.Purpose || handoff.Independence != context.Independence {
		Raise("context_rejected", "Context handoff does not match the resolved context mode")
	}
	if strings.TrimSpace(handoff.Summary) == "" || strings.TrimSpace(handoff.Briefing) == "" {
		Raise("context_rejected", "Context handoff requires a summary and briefing")
	}
	if context.Purpose != ContextPurposeDiscuss && len(handoff.Acceptance) == 0 {
		Raise("context_rejected", "Context handoff requires the frozen acceptance contract")
	}
	for _, ref := range handoff.ArtifactRefs {
		if strings.TrimSpace(ref.Path) == "" || !contextDigestPattern.MatchString(ref.Digest) {
			Raise("context_rejected", "Context handoff requires artifact references with exact digests")
		}
		if (ref.ArtifactId == nil) != (ref.Version == nil) {
			Raise("context_rejected", "Context handoff requires artifact references with exact digests")
		}
		if ref.ArtifactId == nil {
			continue
		}
		if strings.TrimSpace(*ref.ArtifactId) == "" || ref.Version == nil || !jsSafeInteger(*ref.Version) || *ref.Version < 1 {
			Raise("context_rejected", "Context handoff requires artifact references with exact digests")
		}
	}
	if strings.TrimSpace(handoff.OutputSchema.Kind) == "" || !jsSafeInteger(handoff.OutputSchema.Version) || handoff.OutputSchema.Version < 1 {
		Raise("context_rejected", "Context handoff requires an output schema")
	}
}

func contextReviewPolicy(context ResolvedAgentContext) *string {
	if context.ReviewPolicy == nil {
		return nil
	}
	text := CanonicalJSON(context.ReviewPolicy)
	return &text
}

func contextOptionalString(value any) *string {
	if value == nil {
		return nil
	}
	text := kernelString(value)
	return &text
}

func contextOptionalStringValue(value string) *string {
	if value == "" {
		return nil
	}
	return &value
}

func contextOptionalText(value *string) any {
	if value == nil {
		return nil
	}
	return *value
}

func contextParseJSON(text string) any {
	var parsed any
	if err := json.Unmarshal([]byte(text), &parsed); err != nil {
		panic(err)
	}
	return parsed
}
