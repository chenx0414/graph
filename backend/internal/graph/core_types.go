package graph

import (
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
	"unicode/utf16"
)

// Json is the TypeScript Json union: nil, bool, float64, string, []any, or map[string]any.
type Json = any

const maxSafeInteger = 9007199254740991

func isSafeInteger(value any) bool {
	f, ok := asFloat(value)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) || f != math.Trunc(f) {
		return false
	}
	return f >= -maxSafeInteger && f <= maxSafeInteger
}

func isJSInteger(value any) bool {
	f, ok := asFloat(value)
	if !ok || math.IsNaN(f) || math.IsInf(f, 0) {
		return false
	}
	return f == math.Trunc(f)
}

func asFloat(value any) (float64, bool) {
	switch v := value.(type) {
	case float64:
		return v, true
	case float32:
		return float64(v), true
	case int:
		return float64(v), true
	case int64:
		return float64(v), true
	case int32:
		return float64(v), true
	case json.Number:
		f, err := v.Float64()
		return f, err == nil
	default:
		return 0, false
	}
}

func asInt(value any) int64 {
	switch v := value.(type) {
	case int64:
		return v
	case int:
		return int64(v)
	case int32:
		return int64(v)
	case float64:
		return int64(v)
	case json.Number:
		i, err := v.Int64()
		if err != nil {
			f, ferr := v.Float64()
			if ferr != nil {
				return 0
			}
			return int64(f)
		}
		return i
	default:
		return 0
	}
}

func jsonRecord(value any) (map[string]any, bool) {
	record, ok := value.(map[string]any)
	return record, ok && record != nil
}

func jsonClone(value any) any {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		panic(err)
	}
	return out
}

func jsonStringify(value any) string {
	raw, err := json.Marshal(value)
	if err != nil {
		panic(err)
	}
	return string(raw)
}

// utf16Len counts UTF-16 code units, which is what TypeScript's string.length
// counts. Limits carried over from the TypeScript contract are measured in it.
func utf16Len(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func utf16Slice(value string, n int) string {
	units := utf16.Encode([]rune(value))
	if n > len(units) {
		n = len(units)
	}
	if n < 0 {
		n = 0
	}
	return string(utf16.Decode(units[:n]))
}

func enUS(n int) string {
	negative := n < 0
	if negative {
		n = -n
	}
	digits := strconv.Itoa(n)
	out := make([]byte, 0, len(digits)+len(digits)/3)
	for i := 0; i < len(digits); i++ {
		if i > 0 && (len(digits)-i)%3 == 0 {
			out = append(out, ',')
		}
		out = append(out, digits[i])
	}
	if negative {
		return "-" + string(out)
	}
	return string(out)
}

func graphDBRow(db *sql.DB, query string, args ...any) (map[string]any, bool) {
	rows := graphDBAll(db, query, args...)
	if len(rows) == 0 {
		return nil, false
	}
	return rows[0], true
}

func graphDBAll(db *sql.DB, query string, args ...any) []map[string]any {
	rows, err := db.Query(query, args...)
	if err != nil {
		panic(err)
	}
	defer rows.Close()
	cols, err := rows.Columns()
	if err != nil {
		panic(err)
	}
	out := []map[string]any{}
	for rows.Next() {
		dest := make([]any, len(cols))
		ptrs := make([]any, len(cols))
		for i := range dest {
			ptrs[i] = &dest[i]
		}
		if err := rows.Scan(ptrs...); err != nil {
			panic(err)
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = normalizeSQL(dest[i])
		}
		out = append(out, row)
	}
	if err := rows.Err(); err != nil {
		panic(err)
	}
	return out
}

func graphDBExec(db *sql.DB, query string, args ...any) int64 {
	result, err := db.Exec(query, args...)
	if err != nil {
		panic(err)
	}
	n, err := result.RowsAffected()
	if err != nil {
		panic(err)
	}
	return n
}

func normalizeSQL(value any) any {
	switch v := value.(type) {
	case []byte:
		return string(v)
	default:
		return v
	}
}

func graphDBString(row map[string]any, key string) string {
	switch v := row[key].(type) {
	case string:
		return v
	case []byte:
		return string(v)
	default:
		return ""
	}
}

func graphDBStringPtr(row map[string]any, key string) *string {
	if row[key] == nil {
		return nil
	}
	value := graphDBString(row, key)
	return &value
}

func graphDBInt(row map[string]any, key string) int64 {
	if row == nil {
		return 0
	}
	return asInt(row[key])
}

type ProjectConfig struct {
	Id     string   `json:"id"`
	Root   string   `json:"root"`
	Grants []string `json:"grants,omitempty"`
}

type ContextPurpose string

const (
	ContextPurposeDiscuss   ContextPurpose = "discuss"
	ContextPurposeExplore   ContextPurpose = "explore"
	ContextPurposeImplement ContextPurpose = "implement"
	ContextPurposeReview    ContextPurpose = "review"
	ContextPurposeVerify    ContextPurpose = "verify"
	ContextPurposeRework    ContextPurpose = "rework"
)

type ContextIndependence string

const (
	ContextIndependenceNone          ContextIndependence = "none"
	ContextIndependenceFresh         ContextIndependence = "fresh"
	ContextIndependenceModelExcluded ContextIndependence = "model-excluded"
)

type ContextFactKind string

const (
	ContextFactArtifact        ContextFactKind = "artifact"
	ContextFactDecision        ContextFactKind = "decision"
	ContextFactFile            ContextFactKind = "file"
	ContextFactTranscriptRange ContextFactKind = "transcript_range"
	ContextFactToolCall        ContextFactKind = "tool_call"
)

type ContextFactRef struct {
	Kind ContextFactKind `json:"kind"`
	Ref  *string         `json:"ref,omitempty"`
	From *string         `json:"from,omitempty"`
	To   *string         `json:"to,omitempty"`
}

type AgentContextMode string

const (
	AgentContextContinue AgentContextMode = "continue"
	AgentContextFresh    AgentContextMode = "fresh"
)

type ReviewIndependencePolicy struct {
	FreshRequired  bool     `json:"freshRequired"`
	EvidenceOnly   bool     `json:"evidenceOnly"`
	ExcludedModels []string `json:"excludedModels"`
	AllowedTools   []string `json:"allowedTools"`
	ReportSchema   struct {
		Kind    string `json:"kind"`
		Version int    `json:"version"`
	} `json:"reportSchema"`
}

type ContextHandoffPackage struct {
	Mode             AgentContextMode    `json:"mode"`
	Purpose          ContextPurpose      `json:"purpose"`
	Independence     ContextIndependence `json:"independence"`
	RequestedFacts   []ContextFactRef    `json:"requestedFacts"`
	ReasonCode       string              `json:"reasonCode"`
	SourceNodeId     *string             `json:"sourceNodeId"`
	SourceInstanceId *string             `json:"sourceInstanceId"`
	SourceSessionId  *string             `json:"sourceSessionId"`
	SourceLeafId     *string             `json:"sourceLeafId"`
	Summary          string              `json:"summary"`
	Decisions        []string            `json:"decisions"`
	Acceptance       []AcceptanceItem    `json:"acceptance"`
	ArtifactRefs     []ArtifactReference `json:"artifactRefs"`
	OutputSchema     SchemaRef           `json:"outputSchema"`
	Briefing         string              `json:"briefing"`
}

type AcceptanceItem struct {
	Id          string `json:"id"`
	Description string `json:"description"`
	CheckNode   string `json:"checkNode"`
}

type SchemaRef struct {
	Kind    string `json:"kind"`
	Version int    `json:"version"`
}

type ResolvedAgentContext struct {
	Mode              AgentContextMode          `json:"mode"`
	Purpose           ContextPurpose            `json:"purpose"`
	Independence      ContextIndependence       `json:"independence"`
	RequestedFacts    []ContextFactRef          `json:"requestedFacts"`
	ReasonCode        string                    `json:"reasonCode"`
	BindingId         string                    `json:"bindingId"`
	ResolutionId      string                    `json:"resolutionId"`
	HandoffId         string                    `json:"handoffId"`
	HandoffDigest     string                    `json:"handoffDigest"`
	ConstraintsDigest string                    `json:"constraintsDigest"`
	BudgetScopeId     string                    `json:"budgetScopeId"`
	ModelPolicyDigest *string                   `json:"modelPolicyDigest,omitempty"`
	ToolPolicyDigest  *string                   `json:"toolPolicyDigest,omitempty"`
	ReviewPolicy      *ReviewIndependencePolicy `json:"reviewPolicy,omitempty"`
	SourceLeafId      *string                   `json:"sourceLeafId,omitempty"`
}

// NodeSpec is the internal record for main. Graph declarations use NodeDefinition.
type NodeSpec struct {
	Id                string  `json:"id"`
	Kind              string  `json:"kind"`
	Action            string  `json:"action"`
	Input             Json    `json:"input,omitempty"`
	DefinitionVersion *string `json:"definitionVersion,omitempty"`
	Model             *string `json:"model,omitempty"`
	Role              *string `json:"role,omitempty"`
}

type ProposalScope struct {
	RequirementVersion int              `json:"requirementVersion"`
	Summary            string           `json:"summary"`
	Acceptance         []AcceptanceItem `json:"acceptance"`
	Decisions          []string         `json:"decisions,omitempty"`
}

// NativeProposal is a declarative graph draft. Main belongs outside its definition.
type NativeProposal struct {
	RequirementVersion int              `json:"requirementVersion"`
	Summary            string           `json:"summary"`
	Acceptance         []AcceptanceItem `json:"acceptance"`
	Decisions          []string         `json:"decisions,omitempty"`
	Definition         GraphDefinition  `json:"definition"`
}

type Receipt struct {
	TaskId string `json:"taskId"`
	Cursor int    `json:"cursor"`
}

type ProposalReceipt struct {
	TaskId          string `json:"taskId"`
	Cursor          int    `json:"cursor"`
	ProposalVersion int    `json:"proposalVersion"`
	DraftRevision   int    `json:"draftRevision"`
}

type TaskUpdate struct {
	Cursor    int    `json:"cursor"`
	TaskId    string `json:"taskId"`
	Type      string `json:"type"`
	Data      Json   `json:"data"`
	Timestamp int64  `json:"timestamp"`
}

// TaskWatch is the async iterator returned by a task event watch.
type TaskWatch struct {
	Next func() (TaskUpdate, bool)
	Stop func()
}

type ArtifactReference struct {
	Path       string  `json:"path"`
	Digest     string  `json:"digest"`
	ArtifactId *string `json:"artifactId,omitempty"`
	Version    *int    `json:"version,omitempty"`
	Uri        *string `json:"uri,omitempty"`
}

type EvidenceInput struct {
	AcceptanceId string            `json:"acceptanceId"`
	Summary      string            `json:"summary"`
	Artifact     ArtifactReference `json:"artifact"`
}

type ArtifactInput struct {
	Path       string  `json:"path"`
	Digest     string  `json:"digest"`
	ArtifactId *string `json:"artifactId,omitempty"`
	Version    *int    `json:"version,omitempty"`
	Uri        *string `json:"uri,omitempty"`
	Id         string  `json:"id"`
}

type ArtifactVersion struct {
	Path         string  `json:"path"`
	Digest       string  `json:"digest"`
	ArtifactId   *string `json:"artifactId,omitempty"`
	Version      *int    `json:"version,omitempty"`
	Uri          *string `json:"uri,omitempty"`
	Id           string  `json:"id"`
	NodeId       string  `json:"nodeId"`
	OperationId  string  `json:"operationId"`
	ActivationId string  `json:"activationId"`
}

type DependencySource struct {
	NodeId        string            `json:"nodeId"`
	InstanceId    *string           `json:"instanceId"`
	OperationId   string            `json:"operationId"`
	ActivationId  string            `json:"activationId"`
	OutputVersion int               `json:"outputVersion"`
	Artifacts     []ArtifactVersion `json:"artifacts"`
}

type OperationAnswer struct {
	QuestionId string `json:"questionId"`
	Value      Json   `json:"value"`
}

type OperationMessage struct {
	Id                 *string           `json:"id,omitempty"`
	Text               string            `json:"text"`
	RequirementVersion int               `json:"requirementVersion"`
	Attachments        []AttachmentInput `json:"attachments,omitempty"`
	Command            *string           `json:"command,omitempty"`
}

type OperationWake struct {
	Kind      string  `json:"kind"`
	DedupeKey string  `json:"dedupeKey"`
	TaskId    string  `json:"taskId"`
	Data      *string `json:"data"`
}

type RsiContinuation struct {
	RequestId   string `json:"requestId"`
	OperationId string `json:"operationId"`
	Commit      string `json:"commit"`
}

type OperationContext struct {
	PreviousOutput  Json                  `json:"previousOutput"`
	RsiContinuation *RsiContinuation      `json:"rsiContinuation,omitempty"`
	Wakes           []OperationWake       `json:"wakes,omitempty"`
	Answers         []OperationAnswer     `json:"answers"`
	Messages        []OperationMessage    `json:"messages,omitempty"`
	Briefing        *string               `json:"briefing,omitempty"`
	AgentContext    *ResolvedAgentContext `json:"agentContext,omitempty"`
	OutputSchema    *SchemaRef            `json:"outputSchema,omitempty"`
}

type InputVersion struct {
	ActivationId  string `json:"activationId"`
	OutputVersion int    `json:"outputVersion"`
}

type Operation struct {
	Id                 string                        `json:"id"`
	TaskId             string                        `json:"taskId"`
	NodeId             string                        `json:"nodeId"`
	InstanceId         *string                       `json:"instanceId"`
	Generation         int                           `json:"generation"`
	Attempt            int                           `json:"attempt"`
	Kind               string                        `json:"kind"`
	Action             string                        `json:"action"`
	Input              Json                          `json:"input"`
	Dependencies       map[string]Json               `json:"dependencies"`
	ProposalVersion    int                           `json:"proposalVersion"`
	RequirementVersion int                           `json:"requirementVersion"`
	Context            OperationContext              `json:"context"`
	Grants             []string                      `json:"grants"`
	AccessPolicy       *ResolvedAccessPolicy         `json:"accessPolicy,omitempty"`
	ActivationId       string                        `json:"activationId"`
	GraphVersion       int                           `json:"graphVersion"`
	DependencySources  map[string][]DependencySource `json:"dependencySources"`
	InputVersions      map[string][]InputVersion     `json:"inputVersions"`
	Workspace          *string                       `json:"workspace,omitempty"`
}

type AttachmentInput struct {
	Name string  `json:"name"`
	Type string  `json:"type"`
	Size int64   `json:"size"`
	Text string  `json:"text"`
	Data *string `json:"data,omitempty"`
}

type OperationQuestion struct {
	Prompt string  `json:"prompt"`
	Grant  *string `json:"grant,omitempty"`
	Data   Json    `json:"data,omitempty"`
}

type OperationResult struct {
	Outcome   string             `json:"outcome"`
	Output    Json               `json:"output"`
	Usage     *TokenUsage        `json:"usage,omitempty"`
	Evidence  []EvidenceInput    `json:"evidence,omitempty"`
	Question  *OperationQuestion `json:"question,omitempty"`
	Artifacts []ArtifactInput    `json:"artifacts,omitempty"`
}

// Answer is one user reply to a parked question.
type Answer struct {
	Type   string      `json:"type"`
	Tokens int64       `json:"tokens,omitempty"`
	Value  Json        `json:"value,omitempty"`
	Grant  string      `json:"grant,omitempty"`
	Reason *string     `json:"reason,omitempty"`
	Usage  *TokenUsage `json:"usage,omitempty"`
	Proof  string      `json:"proof,omitempty"`
}

type Reconciliation struct {
	State     string           `json:"state"`
	Result    *OperationResult `json:"result,omitempty"`
	Quiescent bool             `json:"quiescent"`
	Proof     string           `json:"proof"`
}

// ActionAdapter is the trusted host adapter. Optional methods are nil when absent.
type ActionAdapter struct {
	Kind                string
	ReserveTokens       *int
	Grant               *string
	Prepare             func(operation Operation) func() OperationResult
	Steer               func(operation Operation, text string) any
	Interrupt           func(operation Operation, text *string) any
	Stop                func(operation Operation)
	Reconcile           func(operation Operation) Reconciliation
	CanReplayBeforeSend func(operation Operation) bool
}
