package graph

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
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

// TaskRuntimeModels is the static model configuration of one runtime.
type TaskRuntimeModels struct {
	Entries        []ConfiguredModel
	Preferences    map[string][]string
	APIKey         string
	ModelRuntime   *ModelRuntime
	ModelScheduler *ModelScheduler
	CredentialFor  func(ConfiguredModel) *ResolvedCredential
}

// TaskRuntimeLive is the hot-reloadable configuration view of one runtime.
type TaskRuntimeLive struct {
	Revision            func() int
	Config              func() GraphConfig
	Entries             func() []ConfiguredModel
	Preferences         func() map[string][]string
	CredentialFor       func(ConfiguredModel) *ResolvedCredential
	MasterModel         func() string
	DefaultBudgetTokens func() *int
	Projects            func() []ProjectConfig
}

// TaskRuntimeMaster is the master Agent binding of one runtime.
type TaskRuntimeMaster struct {
	Action            string
	Model             func() string
	DefinitionVersion func() string
}

// TaskRuntimeCatalog is the capability library configuration of one runtime.
type TaskRuntimeCatalog struct {
	CapabilityRoot      string
	RecipesPath         string
	BootstrapPrompts    map[string]string
	BootstrapToolPrompt string
}

// TaskRuntimeLimits are the default budget limits of one runtime.
type TaskRuntimeLimits struct {
	DefaultBudgetTokens func() *int
}

// TaskRuntimeSystemContext is the read-only host inventory of one runtime.
type TaskRuntimeSystemContext struct {
	SystemSummary func() any
}

// TaskRuntimeHost is the host side of one runtime.
type TaskRuntimeHost struct {
	runtime *TaskRuntime
}

// Pump dispatches the work that is ready.
func (h *TaskRuntimeHost) Pump() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.pump()
}

// AckRsiRestart clears a pending RSI restart and wakes the dispatch loop.
func (h *TaskRuntimeHost) AckRsiRestart(id string) any {
	if h == nil || h.runtime == nil {
		Raise("rsi_unavailable", "RSI is unavailable")
	}
	return h.runtime.AckRsiRestart(id)
}

// RunReady dispatches every operation that is ready.
func (h *TaskRuntimeHost) RunReady() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.RunReady()
}

// CheckProjects is the read-only candidate check: a hot config that moves the
// root of a project with tasks in flight must be rejected.
func (h *TaskRuntimeHost) CheckProjects(projects []ProjectConfig) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.CheckProjects(projects)
}

// SyncProjects registers hot-added projects and rejects root moves while
// tasks are in flight.
func (h *TaskRuntimeHost) SyncProjects() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.SyncProjects()
}

// Drive runs one dispatch round.
func (h *TaskRuntimeHost) Drive() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.Drive()
}

// Report hands an operation result back to the runtime.
func (h *TaskRuntimeHost) Report(id string, generation int, result OperationResult) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Report(id, generation, result)
}

// Reconcile re-reads the state of one operation.
func (h *TaskRuntimeHost) Reconcile(id string) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Reconcile(id)
}

// RecoverMasters creates master nodes for pending tasks after a hot
// configuration apply.
func (h *TaskRuntimeHost) RecoverMasters() int {
	if h == nil || h.runtime == nil {
		return 0
	}
	return h.runtime.RecoverMasters()
}

// TaskRuntime is the backend runtime: tasks, conversations, graphs and the host loop.
type TaskRuntime struct {
	options    GraphServerOptions
	mu         sync.Mutex
	store      *TaskStore
	kernel     *KernelStore
	catalog    *Catalog
	git        *GitIntegration
	artifacts  *ArtifactWorkspace
	execution  *Execution
	scheduler  *ModelScheduler
	closed     bool
	stateDir   string
	projects   []ProjectConfig
	live       *TaskRuntimeLive
	models     *TaskRuntimeModels
	master     *TaskRuntimeMaster
	catalogOpt *TaskRuntimeCatalog
	limits     *TaskRuntimeLimits
	access     func() AccessPolicy
	agentCtx   *AgentContextLibrary
	systemCtx  *TaskRuntimeSystemContext
	rsi        *RsiService
	autoWake   bool
	Host       *TaskRuntimeHost
	// graphLane is the resident v2 lane; laneTokenBudget is the live budget it
	// runs its nodes under.
	graphLane       *GraphLane
	laneTokenBudget *TokenBudget
}

// OpenTaskRuntime opens the backend runtime over one state directory.
func OpenTaskRuntime(options GraphServerOptions) *TaskRuntime {
	runtime := &TaskRuntime{options: options, stateDir: options.StateDir, projects: options.Projects}
	if options.AutoDrive != nil {
		runtime.autoWake = *options.AutoDrive
	}
	if err := os.MkdirAll(options.StateDir, 0o700); err != nil {
		panic(err)
	}
	resolved, err := filepath.EvalSymlinks(options.StateDir)
	if err != nil {
		panic(err)
	}
	runtime.stateDir = resolved

	// The option bags stay non-nil so a runtime opened without one still has
	// an empty configuration to read.
	runtime.models = options.Models
	if runtime.models == nil {
		runtime.models = &TaskRuntimeModels{}
	}
	runtime.live = options.Live
	if runtime.live == nil {
		runtime.live = &TaskRuntimeLive{}
	}
	runtime.master = options.Master
	if runtime.master == nil {
		runtime.master = &TaskRuntimeMaster{}
	}
	runtime.catalogOpt = options.Catalog
	if runtime.catalogOpt == nil {
		runtime.catalogOpt = &TaskRuntimeCatalog{}
	}
	runtime.limits = options.Limits
	if runtime.limits == nil {
		runtime.limits = &TaskRuntimeLimits{}
	}
	runtime.agentCtx = options.AgentContext
	runtime.rsi = options.Rsi
	runtime.access = options.Access
	runtime.systemCtx = options.SystemContext

	releaseOwner := AcquireOwner(filepath.Join(runtime.stateDir, "owner.sqlite"))
	store, err := OpenSQLite(filepath.Join(runtime.stateDir, "tasks.sqlite"))
	if err != nil {
		releaseOwner()
		panic(err)
	}
	runtime.store = NewTaskStore(store, filepath.Join(runtime.stateDir, "tasks.sqlite"))
	defer func() {
		if recovered := recover(); recovered != nil {
			runtime.store.Close()
			releaseOwner()
			panic(recovered)
		}
	}()

	runtime.kernel = NewKernelStore(runtime.store)
	RetireLegacyGraphs(runtime.store)
	RecoverKernelExecutions(runtime.kernel)

	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		budget := runtime.limits.DefaultBudgetTokens()
		if budget != nil && *budget <= 0 {
			Raise("invalid_input", "limits.defaultBudgetTokens must be a positive integer or null")
		}
	}
	runtime.store.Transaction(func() any {
		for _, project := range runtime.configuredProjects() {
			if strings.TrimSpace(project.Id) == "" || strings.TrimSpace(project.Root) == "" {
				Raise("invalid_input", "Project identity, root and grants must be nonempty strings")
			}
			root, err := filepath.Abs(project.Root)
			if err != nil {
				root = project.Root
			}
			grants := taskRuntimeGrants(project.Grants)
			previous := kernelRow(runtime.store.Db, "SELECT root,grants FROM projects WHERE id=?", project.Id)
			if previous != nil && (kernelString(previous["root"]) != root || (project.Grants != nil && kernelString(previous["grants"]) != grants)) {
				Raise("project_conflict", "Persisted project root and base grants cannot change during restore")
			}
			kernelExec(runtime.store.Db, "INSERT OR IGNORE INTO projects VALUES(?,?,?)", project.Id, root, grants)
		}
		return nil
	})

	runtime.catalog = NewCatalog(runtime.store, CatalogOptions{
		CapabilityRoot: runtime.catalogOpt.CapabilityRoot,
		RecipesPath:    runtime.catalogOpt.RecipesPath,
		Projects:       func() []ProjectConfig { return runtime.configuredProjects() },
	})
	runtime.catalog.Refresh()
	runtime.git = NewGitIntegration(runtime.store, runtime.stateDir)
	runtime.artifacts = NewArtifactWorkspace(runtime.store, filepath.Join(runtime.stateDir, "artifact-workspace"))

	runtime.scheduler = CreateModelScheduler()
	if runtime.models != nil && runtime.models.ModelScheduler != nil {
		runtime.scheduler = runtime.models.ModelScheduler
	}
	if runtime.models != nil {
		runtime.store.Transaction(func() any {
			for _, entry := range runtime.models.Entries {
				kernelExec(runtime.store.Db, "INSERT OR REPLACE INTO models VALUES(?,?)", entry.Id, CanonicalJSON(entry))
			}
			return nil
		})
	}
	if runtime.live != nil {
		runtime.store.Transaction(func() any {
			for _, entry := range runtime.live.Entries() {
				kernelExec(runtime.store.Db, "INSERT OR REPLACE INTO models VALUES(?,?)", entry.Id, CanonicalJSON(entry))
			}
			return nil
		})
	}

	fallback := runtime.fallbackAdapter()
	runtime.execution = NewExecution(runtime.store, map[string]ActionAdapter{}, ExecutionExtras{
		Fallback:        fallback,
		Catalog:         runtime.catalog,
		Models:          runtime.liveEntries,
		PreferencesFunc: runtime.livePreferences,
		Git:             runtime.git,
		AutoWake:        runtime.autoWake,
		DispatchAllowed: runtime.dispatchAllowed,
		Graphs:          runtime.graphs,
		SystemContext:   runtime.executionSystemContext(),
		Access:          runtime.resolvedAccessPolicy,
		Artifacts:       runtime.artifacts,
	})
	// The recovery bootstrap belongs to the kernel that owns the durable
	// conversations. The PiG kernel keeps them in this process, so it
	// recovers on its own: the kernel's own receipts settle the turns it
	// finished, and the turns it never sent are sent again.
	runtime.bootstrapPigRecovery()
	runtime.Host = &TaskRuntimeHost{runtime: runtime}
	return runtime
}

// taskRuntimeGrants renders the sorted, deduplicated grant list of one project.
func taskRuntimeGrants(grants []string) string {
	seen := map[string]bool{}
	out := []string{}
	for _, grant := range grants {
		if grant == "" || seen[grant] {
			continue
		}
		seen[grant] = true
		out = append(out, grant)
	}
	sort.Strings(out)
	return CanonicalJSON(out)
}

// configuredProjects reads the projects of the current configuration.
func (runtime *TaskRuntime) configuredProjects() []ProjectConfig {
	if runtime.live != nil && runtime.live.Projects != nil {
		return runtime.live.Projects()
	}
	return runtime.projects
}

// allowedProjects is the set of project ids that may still receive work.
func (runtime *TaskRuntime) allowedProjects() map[string]bool {
	allowed := map[string]bool{}
	for _, project := range runtime.configuredProjects() {
		allowed[project.Id] = true
	}
	return allowed
}

// liveEntries reads the configured models right now.
func (runtime *TaskRuntime) liveEntries() []ModelEntry {
	if runtime.live != nil && runtime.live.Entries != nil {
		entries := runtime.live.Entries()
		out := make([]ModelEntry, 0, len(entries))
		for _, entry := range entries {
			out = append(out, entry.ModelEntry)
		}
		return out
	}
	if runtime.models != nil {
		out := make([]ModelEntry, 0, len(runtime.models.Entries))
		for _, entry := range runtime.models.Entries {
			out = append(out, entry.ModelEntry)
		}
		return out
	}
	return []ModelEntry{}
}

// livePreferences reads the model preferences right now.
func (runtime *TaskRuntime) livePreferences() map[ModelGrade][]string {
	preferences := map[ModelGrade][]string{}
	if runtime.live != nil && runtime.live.Preferences != nil {
		for key, values := range runtime.live.Preferences() {
			preferences[ModelGrade(key)] = values
		}
		return preferences
	}
	if runtime.models != nil {
		for key, values := range runtime.models.Preferences {
			preferences[ModelGrade(key)] = values
		}
	}
	return preferences
}

// liveBudget reads the default budget of a new instance.
func (runtime *TaskRuntime) liveBudget() *int64 {
	if runtime.live != nil && runtime.live.DefaultBudgetTokens != nil {
		budget := runtime.live.DefaultBudgetTokens()
		if budget == nil {
			return nil
		}
		value := int64(*budget)
		return &value
	}
	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		budget := runtime.limits.DefaultBudgetTokens()
		if budget == nil {
			return nil
		}
		value := int64(*budget)
		return &value
	}
	return nil
}

// masterModel reads the master Agent model right now.
func (runtime *TaskRuntime) masterModel() *string {
	if runtime.master == nil {
		return nil
	}
	model := ""
	if runtime.master.Model != nil {
		model = runtime.master.Model()
	}
	if strings.TrimSpace(model) == "" {
		return nil
	}
	return &model
}

// masterDefinitionVersion reads the master Agent definition right now.
func (runtime *TaskRuntime) masterDefinitionVersion() *string {
	if runtime.master == nil {
		return nil
	}
	version := ""
	if runtime.master.DefinitionVersion != nil {
		version = runtime.master.DefinitionVersion()
	}
	if strings.TrimSpace(version) == "" {
		return nil
	}
	return &version
}

// configRevision reads the configuration revision recorded with new tasks.
func (runtime *TaskRuntime) configRevision() *int {
	if runtime.live != nil && runtime.live.Revision != nil {
		revision := runtime.live.Revision()
		return &revision
	}
	return nil
}

// resolvedAccessPolicy is the policy frozen for each admitted execution.
func (runtime *TaskRuntime) resolvedAccessPolicy() *ResolvedAccessPolicy {
	policy := AccessPolicy{}
	if runtime.access != nil {
		policy = runtime.access()
	} else {
		policy = StandardAccessPolicy()
	}
	graphHome := filepath.Join(taskRuntimeHome(), ".graph")
	if runtime.catalogOpt.CapabilityRoot != "" {
		graphHome = filepath.Dir(runtime.catalogOpt.CapabilityRoot)
	}
	return ResolveAccessPolicy(policy, AccessPolicyContext{
		Home:      taskRuntimeHome(),
		StateDir:  runtime.stateDir,
		GraphHome: graphHome,
	})
}

// dispatchAllowed reports whether the host still permits dispatch.
func (runtime *TaskRuntime) dispatchAllowed() bool {
	if runtime.rsi == nil {
		return true
	}
	return !runtime.rsi.HasPendingRestart()
}

// executionSystemContext is the host inventory the main Agent may read.
func (runtime *TaskRuntime) executionSystemContext() *ExecutionSystemContext {
	return &ExecutionSystemContext{
		Resources:         true,
		AgentCombinations: true,
		SystemSummary:     runtime.systemCtx != nil && runtime.systemCtx.SystemSummary != nil,
	}
}

// graphs lists the v2 graphs that currently have queued work.
func (runtime *TaskRuntime) graphs() []ExecutionGraph {
	lane := runtime.residentGraphLane()
	// §9: the budget a node runs under is read live, so a configuration change
	// reaches the next turn of a graph that is already running.
	budget := runtime.liveBudgetTokens()
	if runtime.laneTokenBudget != nil {
		runtime.laneTokenBudget.Budget = 0
		runtime.laneTokenBudget.Unlimited = true
		if budget != nil {
			runtime.laneTokenBudget.Budget = float64(*budget)
			runtime.laneTokenBudget.Unlimited = false
		}
	}
	runnable := lane.Runnable()
	out := make([]ExecutionGraph, 0, len(runnable))
	for _, graph := range runnable {
		run := graph.Run
		out = append(out, ExecutionGraph{TaskId: graph.TaskId, Run: func() bool { return run().Drained }})
	}
	return out
}

// liveBudgetTokens is the default token budget of one node, or nil when the
// node may spend without a cap.
func (runtime *TaskRuntime) liveBudgetTokens() *int {
	if runtime.live != nil && runtime.live.DefaultBudgetTokens != nil {
		return runtime.live.DefaultBudgetTokens()
	}
	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		return runtime.limits.DefaultBudgetTokens()
	}
	return nil
}

// projectRootFor is the project workspace of one graph.
func (runtime *TaskRuntime) projectRootFor(graphId string) *string {
	row := kernelRow(runtime.store.Db, "SELECT p.root AS root FROM tasks t JOIN projects p ON p.id=t.project_id WHERE t.id=?", graphId)
	if row == nil {
		return nil
	}
	root := kernelString(row["root"])
	return &root
}

// residentGraphLane is the resident v2 lane of this runtime. Native graphs run
// through one resident Pi host per node.
func (runtime *TaskRuntime) residentGraphLane() *GraphLane {
	if runtime.graphLane != nil {
		return runtime.graphLane
	}
	runtime.laneTokenBudget = &TokenBudget{Budget: 0, Unlimited: true}
	reserve := float64(DEFAULT_V2_RESERVE_TOKENS)
	options := KernelGraphLaneOptions{
		Kernel:        runtime.kernel,
		Access:        runtime.resolvedAccessPolicy,
		Catalog:       runtime.catalog,
		Library:       runtime.agentContextLibrary(),
		Codemode:      runtime.options.Codemode,
		TokenBudget:   runtime.laneTokenBudget,
		ReserveTokens: &reserve,
		Directory:     runtime.liveEntries,
		Preferences:   runtime.livePreferences,
		Scheduler:     runtime.scheduler,
		CredentialFor: func(entry ModelEntry) *KernelGraphLaneCredential {
			binding := runtime.liveCredentialFor(entry)
			if binding == nil {
				return nil
			}
			credential := &KernelGraphLaneCredential{
				ApiKey:        binding.ApiKey,
				Limit:         binding.Limit,
				SharedGroupId: binding.SharedGroupId,
				GroupLimit:    binding.GroupLimit,
			}
			if binding.CredentialId != "" {
				value := binding.CredentialId
				credential.CredentialId = &value
			}
			return credential
		},
		InstancesDir: filepath.Join(runtime.stateDir, "instances"),
		StateDir:     runtime.stateDir,
		GraphHome:    runtime.graphHome(),
		WorkspaceFor: runtime.projectRootFor,
		Git:          runtime.git,
		Artifacts:    runtime.artifacts,
		OnMainMessage: func(graphId, nodeId, text, requestId string) any {
			return SendKernelMainMessage(runtime.kernel, graphId, nodeId, NodeMessageInput{Text: text, RequestID: requestId})
		},
		OnToolCall: func(graphId, nodeId, name string, args any) PiToolAnswer {
			if name != "submit" {
				return PiToolAnswer{Ok: false, Text: "the host does not offer a tool named " + name}
			}
			ok, text := HostSubmitCall(runtime.kernel, graphId, nodeId, args)
			return PiToolAnswer{Ok: ok, Text: text}
		},
	}
	runtime.graphLane = KernelGraphLane(options)
	return runtime.graphLane
}

// agentContextLibrary is the prompt library of this runtime, when it has one.
func (runtime *TaskRuntime) agentContextLibrary() *AgentContextLibrary {
	return runtime.agentCtx
}

// graphHome is the root the capability library lives under.
func (runtime *TaskRuntime) graphHome() string {
	if runtime.catalogOpt != nil && runtime.catalogOpt.CapabilityRoot != "" {
		return filepath.Dir(runtime.catalogOpt.CapabilityRoot)
	}
	return filepath.Join(taskRuntimeHome(), ".graph")
}

// fallbackAdapter builds the adapter that serves the built-in agent action.
func (runtime *TaskRuntime) mainAdapterOptions() PiAdapterOptions {
	options := PiAdapterOptions{
		Store:        runtime.store,
		InstancesDir: filepath.Join(runtime.stateDir, "instances"),
		Catalog:      runtime.catalog,
		Artifacts:    runtime.artifacts,
		Directory:    runtime.liveEntries,
		ApiKey:       runtime.apiKey(),
		ApiKeyFor:    runtime.apiKeyFor,
		BindingFor:   runtime.liveCredentialFor,
		Scheduler:    runtime.scheduler,
		Sediment:     runtime.sedimentSettings,
		ModelRuntime: runtime.modelRuntime(),
		Channels:     runtime.piChannels(),
	}
	// The PiG kernel keeps the durable conversations in this process, and the
	// daemon's own tools are the ones the kernel offers.
	options.Transport = CreatePigAgentSessionTransport(runtime.store, codemodeSettings(runtime.options.Codemode, runtime.stateDir))
	options.DaemonNativeTools = true
	return options
}
func (runtime *TaskRuntime) fallbackAdapter() *ActionAdapter {
	adapter := CreatePiAdapter(runtime.mainAdapterOptions())
	return &adapter
}

// apiKey is the legacy single key every entry shares when no binding exists.
func (runtime *TaskRuntime) apiKey() *string {
	if runtime.models == nil || runtime.models.APIKey == "" {
		return nil
	}
	key := runtime.models.APIKey
	return &key
}

// apiKeyFor is the key of one model, when it has its own credential.
func (runtime *TaskRuntime) apiKeyFor(entry ModelEntry) *string {
	binding := runtime.liveCredentialFor(entry)
	if binding == nil || binding.ApiKey == "" {
		return nil
	}
	key := binding.ApiKey
	return &key
}

// configuredById indexes the configured entries by model id.
func (runtime *TaskRuntime) configuredById() map[string]ConfiguredModel {
	out := map[string]ConfiguredModel{}
	for _, entry := range runtime.liveConfiguredEntries() {
		out[entry.Id] = entry
	}
	return out
}

// liveCredentialFor is the credential binding of one model.
func (runtime *TaskRuntime) liveCredentialFor(entry ModelEntry) *PiAdapterBinding {
	configured, ok := runtime.configuredById()[entry.Id]
	if !ok {
		return nil
	}
	var resolved *ResolvedCredential
	if runtime.live != nil && runtime.live.CredentialFor != nil {
		resolved = runtime.live.CredentialFor(configured)
	} else if runtime.models != nil && runtime.models.CredentialFor != nil {
		resolved = runtime.models.CredentialFor(configured)
	}
	if resolved == nil {
		if runtime.models == nil || runtime.models.APIKey == "" {
			return nil
		}
		return &PiAdapterBinding{ApiKey: runtime.models.APIKey}
	}
	binding := &PiAdapterBinding{
		ApiKey:       resolved.APIKey,
		CredentialId: resolved.CredentialID,
		Limit:        resolved.Limit,
		GroupLimit:   resolved.GroupLimit,
	}
	if resolved.SharedGroupID != "" {
		shared := resolved.SharedGroupID
		binding.SharedGroupId = &shared
	}
	return binding
}

// modelRuntime is the provider registry of the runtime.
func (runtime *TaskRuntime) modelRuntime() *ModelRuntime {
	if runtime.models == nil {
		return nil
	}
	return runtime.models.ModelRuntime
}

// sedimentSettings reads the post-operation skill review settings live.
func (runtime *TaskRuntime) sedimentSettings() SedimentSettings {
	if runtime.live == nil || runtime.live.Config == nil {
		return SedimentSettingsFrom(nil)
	}
	return SedimentSettingsFrom(runtime.live.Config())
}

// piChannels are the host channels the Agent session may use.
func (runtime *TaskRuntime) piChannels() *PiAdapterChannels {
	channels := &PiAdapterChannels{
		Supervisor: func(taskId string) PiAdapterSupervisor {
			supervisor := runtime.Supervisor(taskId)
			return PiAdapterSupervisor{
				Propose: func(proposal NativeProposal, requestId string, newVersion bool) any {
					return supervisor.Propose(TaskRuntimeProposeInput{
						ProposalVersion: proposal.RequirementVersion,
						Summary:         proposal.Summary,
						Acceptance:      proposal.Acceptance,
						Decisions:       proposal.Decisions,
						HasDecisions:    proposal.Decisions != nil,
						Definition:      proposal.Definition,
						RequestId:       requestId,
						NewVersion:      newVersion,
					})
				},
				WithdrawDraft: func(input PiAdapterDraftAction) any {
					return supervisor.WithdrawDraft(TaskRuntimeWithdrawInput{
						ProposalVersion: input.ProposalVersion,
						Reason:          input.Reason,
						RequestId:       input.RequestId,
					})
				},
				ConfirmDraft: func(input PiAdapterConfirmDraft) any {
					return supervisor.ConfirmDraft(TaskRuntimeConfirmInput{
						ProposalVersion: input.ProposalVersion,
						DraftRevision:   input.DraftRevision,
						TargetBranch:    input.TargetBranch,
						RequestId:       input.RequestId,
						Attestation: &TaskRuntimeAttestation{
							Actor:       "agent",
							OnBehalfOf:  "user",
							Instruction: input.Instruction,
						},
					})
				},
				ArchiveDraft: func(input PiAdapterDraftAction) any {
					return supervisor.ArchiveDraft(TaskRuntimeDraftInput{ProposalVersion: input.ProposalVersion, RequestId: input.RequestId})
				},
				RestoreDraft: func(input PiAdapterDraftAction) any {
					return supervisor.RestoreDraft(TaskRuntimeDraftInput{ProposalVersion: input.ProposalVersion, RequestId: input.RequestId})
				},
				DeleteDraft: func(input PiAdapterDraftAction) any {
					return supervisor.DeleteDraft(TaskRuntimeDraftInput{ProposalVersion: input.ProposalVersion, RequestId: input.RequestId})
				},
				GraphState:       func() any { return supervisor.GraphState() },
				TaskStatus:       func(input PiAdapterTaskStatus) any { return supervisor.TaskStatus(TaskRuntimeTaskStatusInput(input)) },
				ValidateProposal: func(proposal NativeProposal) any { return supervisor.ValidateProposal(proposal) },
				ListProjects:     func() any { return supervisor.ListProjects() },
				BindProject:      func(input PiAdapterBindProject) any { return supervisor.BindProject(input.ProjectId, input.RequestId) },
				ListProblems:     func() any { return supervisor.ListProblems() },
				ResolveProblem: func(input PiAdapterResolveProblem) any {
					return supervisor.ResolveProblem(TaskRuntimeResolveInput{
						QuestionId: input.QuestionId,
						Action:     input.Action,
						Response:   input.Response,
						Proof:      input.Proof,
						RequestId:  input.RequestId,
					})
				},
				GraphManagement: runtime.graphManagement(taskId),
			}
		},
		Catalog: runtime.catalog,
		Peers: func(taskId string) PiAdapterPeers {
			return PiAdapterPeers{Deliver: func(from string, input PiAdapterPeerDelivery) any {
				nodeInput := NodeMessageInput{Text: input.Text, RequestID: input.RequestId}
				if input.To == "main" {
					return SendKernelMainMessage(runtime.kernel, taskId, from, nodeInput)
				}
				sender := from
				return SendKernelNodeMessage(runtime.kernel, taskId, input.To, nodeInput, &sender)
			}}
		},
	}
	if runtime.agentCtx != nil {
		channels.AgentContext = runtime.agentCtx
	}
	if runtime.catalogOpt != nil {
		channels.BootstrapPrompts = runtime.catalogOpt.BootstrapPrompts
		if runtime.catalogOpt.BootstrapToolPrompt != "" {
			prompt := runtime.catalogOpt.BootstrapToolPrompt
			channels.BootstrapToolPrompt = &prompt
		}
	}
	return channels
}

// graphManagement binds the graph control surface to one owner task. The
// TypeScript supervisor spread graphManagement() into itself, so the graph
// tools of the main Agent read the same surface.
func (runtime *TaskRuntime) graphManagement(taskId string) AgentToolsGraphManagement {
	service := NewGraphManagement(runtime.kernel, taskId, func(graphId string, branch string) {
		if runtime.git != nil {
			runtime.git.PrepareTask(graphId, branch)
		}
	}, runtime.artifacts)
	return AgentToolsGraphManagement{
		GraphCreate: func(input map[string]any) any {
			request := GraphCreateInput{Definition: input["definition"]}
			if branch, ok := input["targetBranch"].(string); ok && branch != "" {
				request.TargetBranch = &branch
			}
			if requestID, ok := input["requestId"].(string); ok && requestID != "" {
				request.RequestId = &requestID
			}
			return service.GraphCreate(request)
		},
		GraphPatch: func(input map[string]any) any {
			baseRevision, _ := agentToolsNumber(input["baseRevision"])
			return service.GraphPatch(GraphPatchInput{
				GraphId:      agentToolsString(input["graphId"]),
				BaseRevision: int(baseRevision),
				Changes:      graphManagementPatchChange(input["changes"]),
			})
		},
		GraphInspect: func(input map[string]any) any {
			request := GraphInspectInput{GraphId: agentToolsString(input["graphId"])}
			if query, ok := input["query"].(string); ok {
				request.Query = &query
			}
			if id, ok := input["id"].(string); ok {
				request.Id = &id
			}
			if delivery, ok := input["deliveryId"].(string); ok {
				request.DeliveryId = &delivery
			}
			if transition, ok := input["transitionId"].(string); ok {
				request.TransitionId = &transition
			}
			if after, ok := agentToolsNumber(input["after"]); ok {
				value := int(after)
				request.After = &value
			}
			if limit, ok := agentToolsNumber(input["limit"]); ok {
				value := int(limit)
				request.Limit = &value
			}
			return service.GraphInspect(request)
		},
		GraphControl: func(input map[string]any) any {
			request := GraphControlInput{
				GraphId: agentToolsString(input["graphId"]),
				Action:  agentToolsString(input["action"]),
			}
			if nodeID, ok := input["nodeId"].(string); ok {
				request.NodeId = &nodeID
			}
			if moduleID, ok := input["moduleId"].(string); ok {
				request.ModuleId = &moduleID
			}
			if seq, ok := agentToolsNumber(input["seq"]); ok {
				value := int(seq)
				request.Seq = &value
			}
			if operationID, ok := input["operationId"].(string); ok {
				request.OperationId = &operationID
			}
			if callID, ok := input["callId"].(string); ok {
				request.CallId = &callID
			}
			if usage, ok := input["usage"].(map[string]any); ok {
				parsed := &TokenUsage{}
				if value, ok := agentToolsNumber(usage["input"]); ok {
					parsed.Input = int64(value)
				}
				if value, ok := agentToolsNumber(usage["output"]); ok {
					parsed.Output = int64(value)
				}
				if value, ok := agentToolsNumber(usage["cacheRead"]); ok {
					parsed.CacheRead = int64(value)
				}
				if value, ok := agentToolsNumber(usage["cacheWrite"]); ok {
					parsed.CacheWrite = int64(value)
				}
				request.Usage = parsed
			}
			return service.GraphControl(request)
		},
		GraphSend: func(input map[string]any) any {
			request := GraphSendInput{GraphId: agentToolsString(input["graphId"])}
			if nodeID, ok := input["nodeId"].(string); ok {
				request.NodeId = &nodeID
			}
			if name, ok := input["input"].(string); ok {
				request.Input = &name
			}
			if value, ok := input["value"]; ok {
				request.Value = value
			}
			if text, ok := input["text"].(string); ok {
				request.Text = &text
			}
			return service.GraphSend(request)
		},
	}
}

// graphManagementPatchChange reads the changes object of a graph patch.
func graphManagementPatchChange(raw any) PatchChange {
	change := PatchChange{}
	record, ok := raw.(map[string]any)
	if !ok {
		return change
	}
	change.Reason = agentToolsString(record["reason"])
	if definition, ok := record["definition"]; ok && definition != nil {
		parsed := ParseGraphDefinition(definition)
		change.Definition = &parsed
	}
	if patch, ok := record["patch"]; ok && patch != nil {
		change.Patch = patch
		change.HasPatch = true
	}
	if retire, ok := record["retire"].([]any); ok {
		for _, item := range retire {
			if text, ok := item.(string); ok {
				change.Retire = append(change.Retire, text)
			}
		}
	}
	return change
}

// pump dispatches the work that is ready.
func (runtime *TaskRuntime) pump() {
	if runtime.execution == nil {
		return
	}
	runtime.execution.Pump()
}

// ensureOpen refuses work after the runtime closed.
func (runtime *TaskRuntime) ensureOpen() {
	runtime.mu.Lock()
	closed := runtime.closed
	runtime.mu.Unlock()
	if closed {
		Raise("closed", "Runtime is closed")
	}
}

// Close stops the runtime, drains the executor and releases the owner lock.
func (runtime *TaskRuntime) Close() {
	runtime.mu.Lock()
	if runtime.closed {
		runtime.mu.Unlock()
		return
	}
	runtime.closed = true
	runtime.mu.Unlock()
	if runtime.execution != nil {
		runtime.execution.Drain()
		runtime.execution.SettleGraphShutdown()
	}
	runtime.store.Close()
}

// taskRuntimeHome is the home directory of the current user.
func taskRuntimeHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return home
}

// taskRuntimeInvocations lists the provider invocations of one task.
func (runtime *TaskRuntime) taskRuntimeInvocations(taskId string) []map[string]any {
	nodes := map[string]string{}
	for _, node := range runtime.kernel.ListNodes(taskId) {
		nodes[node.NodeId] = node.InstanceId
	}
	out := []map[string]any{}
	for _, row := range InvocationRows(runtime.store, taskId) {
		out = append(out, map[string]any{
			"id":          row.Id,
			"operationId": row.OperationId,
			"instanceId":  row.InstanceId,
			"model":       row.Model,
			"usage":       row.Usage,
			"usageSource": string(row.UsageSource),
			"cost":        row.Cost,
		})
	}
	for _, call := range runtime.kernel.ProviderCalls(taskId) {
		model := "unknown"
		if call.Model != nil {
			model = call.Model.Id
		}
		instanceId := nodes[call.NodeId]
		out = append(out, map[string]any{
			"id":          call.Id,
			"operationId": call.ExecutionId,
			"instanceId":  instanceId,
			"model":       model,
			"usage":       call.Usage,
			"usageSource": "unknown",
			// Native sends have no frozen monetary price receipt yet. Missing prices cannot mean free.
			"cost": map[string]any{"unknown": true},
		})
	}
	return out
}

// TaskRuntimeUser is the user side of one runtime.
type TaskRuntimeUser struct {
	runtime *TaskRuntime
}

// User returns the user side of the runtime.
func (runtime *TaskRuntime) User() *TaskRuntimeUser {
	return &TaskRuntimeUser{runtime: runtime}
}

// TaskRuntimeTask is one task of the user side.
type TaskRuntimeTask struct {
	runtime *TaskRuntime
	taskId  string
}

// Task returns the commands of one task.
func (user *TaskRuntimeUser) Task(taskId string) *TaskRuntimeTask {
	return &TaskRuntimeTask{runtime: user.runtime, taskId: taskId}
}

// BeginInput starts one new task.
type TaskRuntimeBeginInput struct {
	ProjectId string
	Request   string
	RequestId string
}

// Begin starts one new task.
func (user *TaskRuntimeUser) Begin(input TaskRuntimeBeginInput) Receipt {
	runtime := user.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "begin", "projectId": input.ProjectId, "request": input.Request,
	}, func() any {
		if strings.TrimSpace(input.Request) == "" || kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", input.ProjectId) == nil {
			Raise("invalid_input", "A known project and nonempty request are required")
		}
		if !runtime.allowedProjects()[input.ProjectId] {
			Raise("invalid_input", "The project is no longer part of the current configuration")
		}
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		kernelExec(runtime.store.Db, "INSERT INTO tasks(id,project_id,request,created_seq) VALUES(?,?,?,?)", taskId, input.ProjectId, input.Request, sequence)
		if runtime.master != nil && runtime.masterModel() != nil && runtime.masterDefinitionVersion() != nil {
			spec := NodeSpec{
				Id:                "master",
				Kind:              "agent",
				Action:            runtime.master.Action,
				DefinitionVersion: runtime.masterDefinitionVersion(),
				Model:             runtime.masterModel(),
				Role:              taskRuntimeStringPtr("master"),
			}
			instanceId := graphUUID()
			kernelExec(runtime.store.Db, "INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)", taskId, spec.Id, CanonicalJSON(spec), instanceId)
			runtime.insertInstance(instanceId, taskId, spec.Id, spec.DefinitionVersion, spec.Model)
			CreateActivation(runtime.store, taskId, spec.Id, 0)
			active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
			if active == "" {
				kernelExec(runtime.store.Db, "UPDATE runtime SET active_task=?", taskId)
			}
		}
		return map[string]any{
			"taskId": taskId,
			"cursor": runtime.store.Event(taskId, "task.created", map[string]any{"request": input.Request, "configRevision": runtime.configRevision()}),
		}
	})
	return taskRuntimeReceipt(result)
}

func taskRuntimeStringPtr(value string) *string {
	return &value
}

func taskRuntimeReceipt(result any) Receipt {
	record, _ := jsonRecord(result)
	receipt := Receipt{}
	if record != nil {
		if value, ok := record["taskId"].(string); ok {
			receipt.TaskId = value
		}
		if value, ok := record["cursor"].(float64); ok {
			receipt.Cursor = int(value)
		}
	}
	return receipt
}

// insertInstance records the instance row of one node.
func (runtime *TaskRuntime) insertInstance(id, taskId, nodeId string, definitionVersion *string, model *string) string {
	budget := runtime.liveBudget()
	unlimited := 0
	amount := int64(0)
	if budget == nil {
		unlimited = 1
	} else {
		amount = *budget
	}
	kernelExec(runtime.store.Db, "INSERT INTO instances(id,task_id,node_id,definition_version,model,budget,unlimited) VALUES(?,?,?,?,?,?,?)",
		id, taskId, nodeId, definitionVersion, model, amount, unlimited)
	return id
}

// TaskRuntimePauseInput is the input of one pause or resume.
type TaskRuntimePauseInput struct {
	RequestId string
}

// Pause stops the dispatch of a task.
func (task *TaskRuntimeTask) Pause(requestId string) Receipt {
	receipt, stoppedMaster := task.setPaused(true, requestId)
	if stoppedMaster {
		task.runtime.execution.StopActiveMasterTurns(task.taskId)
	}
	return receipt
}

// Resume restarts the dispatch of a task.
func (task *TaskRuntimeTask) Resume(requestId string) Receipt {
	receipt, _ := task.setPaused(false, requestId)
	if task.runtime.autoWake {
		task.runtime.execution.Kick()
	}
	return receipt
}

func (task *TaskRuntimeTask) setPaused(paused bool, requestId string) (Receipt, bool) {
	runtime := task.runtime
	runtime.ensureOpen()
	stoppedMaster := false
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": taskRuntimePauseType(paused), "taskId": task.taskId,
	}, func() any {
		pausedValue := 0
		if paused {
			pausedValue = 1
		}
		kernelExec(runtime.store.Db, "UPDATE tasks SET paused=? WHERE id=?", pausedValue, task.taskId)
		if paused {
			OpenPause(runtime.store, task.taskId)
			active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o
              JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
              WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`, task.taskId)
			if active != nil {
				stoppedMaster = AwaitPauseContinuation(runtime.store, requestId, task.taskId, kernelString(active["id"]))
			}
		} else {
			ClosePause(runtime.store, task.taskId)
			ResumePauseContinuations(runtime.store, task.taskId)
		}
		eventType := "task.resumed"
		if paused {
			eventType = "task.pause_requested"
		}
		return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, eventType, map[string]any{})}
	})
	return taskRuntimeReceipt(result), stoppedMaster
}

func taskRuntimePauseType(paused bool) string {
	if paused {
		return "pause"
	}
	return "resume"
}

// Abandon stops the task for good.
func (task *TaskRuntimeTask) Abandon(requestId string, reason *string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "abandon", "taskId": task.taskId, "reason": reasonValue(reason),
	}, func() any {
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.execution.Abandon(task.taskId, reason, false),
		}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return taskRuntimeReceipt(result)
}

// TaskRuntimeBudgetInput is the input of one budget change.
type TaskRuntimeBudgetInput struct {
	NodeId    string
	Tokens    *int64
	RequestId string
}

// SetBudget changes the budget policy of one node.
func (task *TaskRuntimeTask) SetBudget(input TaskRuntimeBudgetInput) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.NodeId) == "" {
		Raise("invalid_input", "A nodeId is required")
	}
	if input.Tokens != nil && *input.Tokens <= 0 {
		Raise("invalid_input", "Budget must be a positive integer or null")
	}
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "set_budget", "taskId": task.taskId, "nodeId": input.NodeId, "tokens": input.Tokens,
	}, func() any {
		if runtime.kernel.LatestRevision(task.taskId) != nil {
			runtime.kernel.SetAuthorizedBudget(task.taskId, input.NodeId, input.Tokens)
			changes := kernelChanges(runtime.store.Db, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'",
				CanonicalJSON(map[string]any{"type": "set_budget", "tokens": input.Tokens}), task.taskId, input.NodeId)
			if changes > 0 {
				CloseUserWait(runtime.store, task.taskId, input.NodeId)
			}
			return map[string]any{
				"taskId": task.taskId,
				"cursor": runtime.store.Event(task.taskId, "instance.budget_changed", map[string]any{"nodeId": input.NodeId, "tokens": input.Tokens, "nextExecution": true}),
			}
		}
		instance := kernelRow(runtime.store.Db, "SELECT id FROM instances WHERE task_id=? AND node_id=?", task.taskId, input.NodeId)
		if instance == nil {
			Raise("not_found", "Unknown agent node")
		}
		SetBudget(runtime.store, kernelString(instance["id"]), input.Tokens)
		changes := kernelChanges(runtime.store.Db, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'",
			CanonicalJSON(map[string]any{"type": "set_budget", "tokens": input.Tokens}), task.taskId, input.NodeId)
		if changes > 0 {
			CloseUserWait(runtime.store, task.taskId, input.NodeId)
			stillOpen := kernelRow(runtime.store.Db, "SELECT id FROM questions WHERE task_id=? AND node_id=? AND status='open'", task.taskId, input.NodeId)
			if stillOpen == nil {
				kernelExec(runtime.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", task.taskId, input.NodeId)
			}
		}
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.store.Event(task.taskId, "instance.budget_changed", map[string]any{"nodeId": input.NodeId, "tokens": input.Tokens}),
		}
	})
	return taskRuntimeReceipt(result)
}

// Answer resolves one open question.
func (task *TaskRuntimeTask) Answer(questionId string, answer Answer, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "answer", "taskId": task.taskId, "questionId": questionId, "answer": answer,
	}, func() any {
		runtime.execution.Answer(task.taskId, questionId, answer)
		return map[string]any{"taskId": task.taskId, "cursor": runtime.store.Event(task.taskId, "question.answered", map[string]any{"questionId": questionId, "answer": answer})}
	})
	return taskRuntimeReceipt(result)
}

// Say adds a user message to the requirement of a task.
func (task *TaskRuntimeTask) Say(text string, requestId string) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("user", requestId, map[string]any{
		"type": "say", "taskId": task.taskId, "text": text,
	}, func() any {
		current := runtime.store.Task(task.taskId)
		if strings.TrimSpace(text) == "" {
			Raise("invalid_input", "A nonempty message is required")
		}
		if current.AcceptedProposal != nil {
			Raise("requirements_locked", "Confirmed requirements need an explicit impact review")
		}
		kernelExec(runtime.store.Db, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", task.taskId)
		for _, row := range kernelRows(runtime.store.Db, "SELECT id,status,spec FROM nodes WHERE task_id=?", task.taskId) {
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
				panic(err)
			}
			if spec.Role == nil || *spec.Role != "master" {
				continue
			}
			status := kernelString(row["status"])
			if status == "preparing" || status == "running" || HasLockedQuestion(runtime.store, task.taskId, kernelString(row["id"])) {
				continue
			}
			kernelExec(runtime.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id=?", task.taskId, kernelString(row["id"]))
		}
		return map[string]any{
			"taskId": task.taskId,
			"cursor": runtime.store.Event(task.taskId, "requirement.changed", map[string]any{"text": text, "requirementVersion": current.RequirementVersion + 1}),
		}
	})
	return taskRuntimeReceipt(result)
}

// TaskRuntimeAcceptInput is the input of one acceptance.
type TaskRuntimeAcceptInput struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	RequestId       string
}

// Accept confirms the current proposal of a task.
func (task *TaskRuntimeTask) Accept(input TaskRuntimeAcceptInput) Receipt {
	runtime := task.runtime
	runtime.ensureOpen()
	runtime.git.RequireTargetBranch(runtime.store.Task(task.taskId).ProjectID, input.TargetBranch)
	result := runtime.store.Command("user", input.RequestId, map[string]any{
		"type": "accept", "taskId": task.taskId, "proposalVersion": input.ProposalVersion,
		"draftRevision": input.DraftRevision, "targetBranch": input.TargetBranch,
	}, func() any {
		current := runtime.store.Task(task.taskId)
		row := kernelRow(runtime.store.Db, "SELECT requirement_version,spec,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?",
			task.taskId, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil || row["archived_at"] != nil ||
			current.LatestProposal != int64(input.ProposalVersion) ||
			kernelInt(row["requirement_version"]) != current.RequirementVersion {
			Raise("stale_proposal", "Only the current requirement proposal can be accepted")
		}
		if input.DraftRevision != int(kernelInt(row["draft_revision"])) {
			Raise("stale_proposal", "This draft changed after it was reviewed; read it again before accepting")
		}
		if current.AcceptedProposal != nil {
			Raise("already_accepted", "Task already has confirmed requirements")
		}
		if strings.TrimSpace(input.TargetBranch) == "" {
			Raise("invalid_input", "A target branch is required")
		}
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &proposal); err != nil {
			panic(err)
		}
		ValidateProposal(proposal)
		MaterializeGraph(runtime.kernel, task.taskId, ParseGraphDefinition(proposal.Definition), "Confirmed task graph")
		active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
		phase := "queued"
		if active == "" || active == task.taskId {
			phase = "running"
		}
		kernelExec(runtime.store.Db, "UPDATE tasks SET accepted_proposal=?,target_branch=?,phase=?,graph_version=1 WHERE id=?",
			input.ProposalVersion, input.TargetBranch, phase, task.taskId)
		if active == "" || active == task.taskId {
			kernelExec(runtime.store.Db, "UPDATE runtime SET active_task=?", task.taskId)
		}
		return map[string]any{
			"taskId":          task.taskId,
			"proposalVersion": input.ProposalVersion,
			"draftRevision":   kernelInt(row["draft_revision"]),
			"cursor":          runtime.store.Event(task.taskId, "task.accepted", map[string]any{"proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch}),
		}
	})
	runtime.git.PrepareTask(task.taskId, input.TargetBranch)
	if NewKernelStore(runtime.store).LatestRevision(task.taskId) != nil {
		WakeMaster(runtime.store, WakeIntent{TaskID: task.taskId, Kind: "graph_ready", DedupeKey: task.taskId + ":ready", Data: map[string]any{"graphId": task.taskId}, HasData: true})
	}
	return taskRuntimeReceipt(result)
}

// View reads the full task projection.
func (task *TaskRuntimeTask) View() map[string]any {
	runtime := task.runtime
	runtime.ensureOpen()
	current := runtime.store.Task(task.taskId)
	native := runtime.kernel.LatestRevision(task.taskId)
	rows := kernelRows(runtime.store.Db, `SELECT n.id,n.spec,n.instance_id,n.status,n.activation_id,n.output_version,n.stall_count,i.used,i.budget,i.unlimited,i.model,i.definition_version
    FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid`, task.taskId)
	invocations := runtime.taskRuntimeInvocations(task.taskId)
	unknownCost := false
	total := float64(0)
	for _, item := range invocations {
		cost, ok := jsonRecord(item["cost"])
		if !ok {
			continue
		}
		if value, ok := cost["unknown"].(bool); ok && value {
			unknownCost = true
			continue
		}
		if value, ok := cost["amount"].(float64); ok {
			total += value
		}
	}
	cost := map[string]any{"amount": total}
	if unknownCost {
		cost = map[string]any{"unknown": true}
	}
	operations := OperationSnapshots(runtime.store, task.taskId, OperationQuery{Latest: true, Limit: taskRuntimeIntPtr(50)})
	totals := kernelRows(runtime.store.Db, `SELECT node_id,COUNT(*) AS total,SUM(reserved) AS reserved,MAX(worker_active) AS active
    FROM operations WHERE task_id=? GROUP BY node_id`, task.taskId)
	operationCount := int64(0)
	for _, row := range totals {
		operationCount += kernelInt(row["total"])
	}
	questions := kernelRows(runtime.store.Db, "SELECT * FROM questions WHERE task_id=? ORDER BY rowid", task.taskId)
	userQuestions := []map[string]any{}
	for _, question := range questions {
		if kernelString(question["owner"]) == "user" {
			userQuestions = append(userQuestions, question)
		}
	}
	drafts := taskRuntimeDraftProjection(runtime.store, task.taskId, current)
	activeTask := kernelRow(runtime.store.Db, "SELECT id, project_id FROM tasks WHERE id=(SELECT active_task FROM runtime)")
	var queuedBehind any
	if current.Phase == "queued" && activeTask != nil {
		openProblems := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM questions WHERE task_id=? AND owner='main' AND status='open'", kernelString(activeTask["id"]))["count"])
		queuedBehind = map[string]any{"taskId": kernelString(activeTask["id"]), "projectId": kernelString(activeTask["project_id"]), "openProblems": openProblems}
	}
	messages := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT cursor,type,data FROM events WHERE task_id=? AND type IN ('task.created','requirement.changed') ORDER BY cursor", task.taskId) {
		var message map[string]any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &message); err != nil {
			panic(err)
		}
		text, _ := message["text"].(string)
		if text == "" {
			text, _ = message["request"].(string)
		}
		version := 1
		if value, ok := message["requirementVersion"].(float64); ok {
			version = int(value)
		}
		messages = append(messages, map[string]any{"cursor": kernelInt(row["cursor"]), "text": text, "requirementVersion": version})
	}
	operationList := []map[string]any{}
	for _, row := range operations {
		operationList = append(operationList, map[string]any{
			"id":           row.Id,
			"state":        row.State,
			"reserved":     row.Reserved,
			"workerActive": row.WorkerActive,
			"result":       row.Result,
		})
	}
	questionList := []map[string]any{}
	internalProblems := 0
	for _, question := range questions {
		var data any
		if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err == nil {
			questionList = append(questionList, map[string]any{
				"id":          kernelString(question["id"]),
				"nodeId":      kernelString(question["node_id"]),
				"operationId": question["operation_id"],
				"kind":        kernelString(question["kind"]),
				"status":      kernelString(question["status"]),
				"owner":       kernelString(question["owner"]),
				"data":        data,
				"answer":      nil,
			})
		}
		if kernelString(question["owner"]) == "main" && kernelString(question["status"]) == "open" {
			internalProblems++
		}
	}
	nodes := []map[string]any{}
	if native == nil {
		for _, row := range rows {
			var spec NodeSpec
			if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
				panic(err)
			}
			entry := map[string]any{
				"id":            spec.Id,
				"kind":          spec.Kind,
				"action":        spec.Action,
				"instanceId":    row["instance_id"],
				"activationId":  kernelString(row["activation_id"]),
				"outputVersion": kernelInt(row["output_version"]),
				"stallCount":    kernelInt(row["stall_count"]),
				"status":        kernelString(row["status"]),
				"used":          row["used"],
				"unlimited":     kernelInt(row["unlimited"]) != 0,
				"budget":        row["budget"],
				"reserved":      int64(0),
			}
			if row["model"] != nil {
				entry["selectedModel"] = kernelString(row["model"])
			}
			if row["definition_version"] != nil {
				entry["boundDefinition"] = kernelString(row["definition_version"])
			}
			for _, total := range totals {
				if kernelString(total["node_id"]) == spec.Id {
					entry["reserved"] = kernelInt(total["reserved"])
				}
			}
			nodes = append(nodes, entry)
		}
	}
	for _, node := range runtime.kernel.ListNodes(task.taskId) {
		spec, hasSpec := native.Definition.Nodes[node.NodeId]
		ledger := kernelRow(runtime.store.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", task.taskId, node.NodeId)
		binding := kernelRow(runtime.store.Db, "SELECT model_id FROM kernel_node_bindings WHERE task_id=? AND node_id=?", task.taskId, node.NodeId)
		model := ""
		if binding != nil && binding["model_id"] != nil {
			model = kernelString(binding["model_id"])
		}
		recipe := ""
		if hasSpec {
			recipe = spec.Recipe
		}
		used := int64(0)
		reserved := int64(0)
		if ledger != nil {
			used = kernelInt(ledger["used"])
			reserved = kernelInt(ledger["reserved"])
		}
		budget := runtime.liveBudget()
		nodes = append(nodes, map[string]any{
			"id":                node.NodeId,
			"kind":              "agent",
			"action":            node.NodeId,
			"definitionVersion": recipe,
			"model":             model,
			"instanceId":        node.InstanceId,
			"activationId":      "",
			"outputVersion":     0,
			"stallCount":        0,
			"used":              used,
			"reserved":          reserved,
			"unlimited":         budget == nil,
			"budget":            budget,
			"optional":          false,
			"boundDefinition":   recipe,
			"selectedModel":     model,
			"status":            node.Status,
			"origin":            "v2",
			"revisionVersion":   node.RevisionVersion,
		})
	}
	evidence := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT node_id,operation_id,proposal_version,requirement_version,data,activation_id,valid,commit_sha FROM evidence WHERE task_id=? ORDER BY rowid", task.taskId) {
		var data map[string]any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		entry := map[string]any{
			"nodeId":             kernelString(row["node_id"]),
			"operationId":        kernelString(row["operation_id"]),
			"proposalVersion":    kernelInt(row["proposal_version"]),
			"requirementVersion": kernelInt(row["requirement_version"]),
			"activationId":       kernelString(row["activation_id"]),
			"valid":              kernelInt(row["valid"]) != 0,
		}
		for key, value := range data {
			entry[key] = value
		}
		if row["commit_sha"] != nil {
			entry["commitSha"] = kernelString(row["commit_sha"])
		}
		evidence = append(evidence, entry)
	}
	worktrees := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT instance_id,node_id,path,branch FROM worktrees WHERE task_id=?", task.taskId) {
		worktrees = append(worktrees, map[string]any{
			"instanceId": kernelString(row["instance_id"]),
			"nodeId":     kernelString(row["node_id"]),
			"path":       kernelString(row["path"]),
			"branch":     kernelString(row["branch"]),
		})
	}
	revisions := []map[string]any{}
	if native != nil {
		for _, row := range kernelRows(runtime.store.Db, "SELECT version,reason,version-1 AS base_version FROM kernel_revisions WHERE task_id=? ORDER BY version", task.taskId) {
			revisions = append(revisions, map[string]any{
				"version":     kernelInt(row["version"]),
				"reason":      kernelString(row["reason"]),
				"baseVersion": kernelInt(row["base_version"]),
			})
		}
	}
	graphVersion := current.GraphVersion
	if native != nil {
		graphVersion = int64(native.Version)
	}
	var currentProposal any
	if drafts.Current != nil {
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(kernelRow(runtime.store.Db, "SELECT spec FROM proposals WHERE task_id=? AND version=?", task.taskId, current.LatestProposal)["spec"])), &proposal); err == nil {
			currentProposal = proposal
		}
	}
	status := current.Phase
	if current.Paused != 0 {
		pausing := false
		if native != nil {
			pausing = KernelHasActiveWork(runtime.kernel, task.taskId)
		} else {
			for _, row := range totals {
				if kernelInt(row["active"]) != 0 {
					pausing = true
				}
			}
		}
		if pausing {
			status = "pausing"
		} else {
			status = "paused"
		}
	} else {
		for _, question := range userQuestions {
			if kernelString(question["status"]) == "open" {
				status = "blocked"
			}
		}
	}
	oldestId := any(nil)
	if len(operations) > 0 {
		oldestId = operations[0].Id
	}
	return map[string]any{
		"id":                      current.ID,
		"conversationId":          current.ConversationID,
		"projectId":               current.ProjectID,
		"request":                 current.Request,
		"requirementVersion":      current.RequirementVersion,
		"proposalVersion":         current.LatestProposal,
		"acceptedProposalVersion": current.AcceptedProposal,
		"draftRevision":           nil,
		"draftDigest":             nil,
		"graphVersion":            graphVersion,
		"proposal":                currentProposal,
		"messages":                messages,
		"containers":              []any{},
		"loops":                   []any{},
		"revisions":               revisions,
		"targetBranch":            current.TargetBranch,
		"phase":                   current.Phase,
		"paused":                  current.Paused != 0,
		"queuedBehind":            queuedBehind,
		"updatedAt":               kernelRow(runtime.store.Db, "SELECT MAX(timestamp) AS updatedAt FROM events WHERE task_id=?", task.taskId)["updatedAt"],
		"status":                  status,
		"operationHistory":        map[string]any{"total": operationCount, "limit": 50, "hasOlder": operationCount > int64(len(operations)), "oldestId": oldestId},
		"operations":              operationList,
		"questions":               questionList,
		"internalProblemCount":    internalProblems,
		"worktrees":               worktrees,
		"integrationSha":          current.IntegrationSha,
		"nodes":                   nodes,
		"evidence":                evidence,
		"invocations":             invocations,
		"cost":                    cost,
		"cursor":                  kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
	}
}

func taskRuntimeIntPtr(value int) *int {
	return &value
}

// Watch streams the events of one task.
func (task *TaskRuntimeTask) Watch(after int) TaskWatch {
	runtime := task.runtime
	runtime.ensureOpen()
	if after < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	stop := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	cursor := after
	pending := []TaskUpdate{}
	return TaskWatch{
		Next: func() (TaskUpdate, bool) {
			for {
				select {
				case <-stop:
					return TaskUpdate{}, false
				default:
				}
				if len(pending) > 0 {
					update := pending[0]
					pending = pending[1:]
					return update, true
				}
				wake := runtime.store.WaitForChange(ctx)
				rows := kernelRows(runtime.store.Db, "SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT 100", task.taskId, cursor)
				if len(rows) > 0 {
					wake.Cancel()
					for _, row := range rows {
						cursor = int(kernelInt(row["cursor"]))
						var data any
						if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
							panic(err)
						}
						pending = append(pending, TaskUpdate{
							Cursor:    cursor,
							TaskId:    task.taskId,
							Type:      kernelString(row["type"]),
							Data:      data,
							Timestamp: kernelInt(row["timestamp"]),
						})
					}
					continue
				}
				// The wake normally fires immediately; the bounded fallback
				// heals any writer that could not notify and keeps the
				// stream caught up with the database.
				select {
				case <-wake.Promise:
				case <-time.After(250 * time.Millisecond):
				case <-stop:
					return TaskUpdate{}, false
				}
				wake.Cancel()
			}
		},
		Stop: func() { once.Do(func() { close(stop); cancel() }) },
	}
}

// List reads the task list.
func (user *TaskRuntimeUser) List() []map[string]any {
	runtime := user.runtime
	runtime.ensureOpen()
	rows := kernelRows(runtime.store.Db, `SELECT t.id,t.project_id AS projectId,t.request,t.phase,t.paused,t.accepted_proposal AS acceptedProposalVersion,
    t.conversation_id AS conversationId,
    (SELECT MIN(timestamp) FROM events WHERE task_id=t.id) AS createdAt,
    (SELECT MAX(timestamp) FROM events WHERE task_id=t.id) AS updatedAt,
    (SELECT COUNT(*) FROM questions WHERE task_id=t.id AND status='open' AND owner='user') AS openQuestions
    FROM tasks t WHERE t.phase!='chatting' ORDER BY t.created_seq`)
	out := []map[string]any{}
	for _, row := range rows {
		status := kernelString(row["phase"])
		switch {
		case kernelInt(row["paused"]) != 0:
			status = "paused"
		case kernelInt(row["openQuestions"]) > 0:
			status = "blocked"
		}
		out = append(out, map[string]any{
			"id":                      kernelString(row["id"]),
			"projectId":               kernelString(row["projectId"]),
			"request":                 kernelString(row["request"]),
			"phase":                   kernelString(row["phase"]),
			"conversationId":          row["conversationId"],
			"status":                  status,
			"acceptedProposalVersion": row["acceptedProposalVersion"],
			"createdAt":               row["createdAt"],
			"updatedAt":               row["updatedAt"],
			"openQuestions":           kernelInt(row["openQuestions"]),
		})
	}
	return out
}

// Projects reads the configured projects with their preparation state.
func (user *TaskRuntimeUser) Projects() []map[string]any {
	runtime := user.runtime
	runtime.ensureOpen()
	out := []map[string]any{}
	for _, project := range runtime.configuredProjects() {
		root, err := filepath.Abs(project.Root)
		if err != nil {
			root = project.Root
		}
		entry := map[string]any{
			"id":          project.Id,
			"root":        root,
			"grants":      taskRuntimeGrants(project.Grants),
			"branch":      nil,
			"preparation": runtime.git.Preparation(project.Id),
		}
		if branch := CheckedOutBranch(root); branch != nil {
			entry["branch"] = *branch
		}
		out = append(out, entry)
	}
	return out
}

// Events reads the events of one task.
func (runtime *TaskRuntime) Events(taskId string, after int, limit int) []TaskUpdate {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	cap := limit
	if cap <= 0 {
		cap = 200
	}
	if cap > 500 {
		cap = 500
	}
	out := []TaskUpdate{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT cursor,type,data,timestamp FROM events WHERE task_id=? AND cursor>? ORDER BY cursor LIMIT ?", taskId, after, cap) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, TaskUpdate{
			Cursor:    int(kernelInt(row["cursor"])),
			TaskId:    taskId,
			Type:      kernelString(row["type"]),
			Data:      data,
			Timestamp: kernelInt(row["timestamp"]),
		})
	}
	return out
}

// Operations reads the operations of one task.
func (runtime *TaskRuntime) Operations(taskId string, query OperationQuery) []map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	limit := 50
	if query.Limit != nil && *query.Limit > 0 {
		limit = *query.Limit
		if limit > 100 {
			limit = 100
		}
	}
	scoped := query
	scoped.Limit = &limit
	rows := OperationSnapshots(runtime.store, taskId, scoped)
	out := []map[string]any{}
	for _, row := range rows {
		entry := map[string]any{
			"id":           row.Id,
			"state":        row.State,
			"reserved":     row.Reserved,
			"workerActive": row.WorkerActive,
			"result":       row.Result,
		}
		if row.DispatchedAt != nil {
			entry["startedAt"] = *row.DispatchedAt
		}
		if row.SettledAt != nil {
			entry["endedAt"] = *row.SettledAt
			duration := *row.SettledAt
			if row.DispatchedAt != nil {
				duration -= *row.DispatchedAt
			}
			entry["durationMs"] = duration
		}
		out = append(out, entry)
	}
	return out
}

// Models reads the configured models right now.
func (runtime *TaskRuntime) Models() []map[string]any {
	runtime.ensureOpen()
	out := []map[string]any{}
	for _, entry := range runtime.liveEntries() {
		record := map[string]any{
			"id":              entry.Id,
			"provider":        entry.Provider,
			"grade":           string(entry.Grade),
			"api":             string(entry.Api),
			"baseUrl":         entry.BaseUrl,
			"contextWindow":   entry.ContextWindow,
			"maxTokens":       entry.MaxTokens,
			"tier":            string(ModelTierOf(entry.Grade)),
			"thinkingOptions": ThinkingOptionsFor(entry),
		}
		out = append(out, record)
	}
	return out
}

// DefaultModel is the model a new conversation would use before any override.
func (runtime *TaskRuntime) DefaultModel() *string {
	runtime.ensureOpen()
	return runtime.masterModel()
}

// CurrentAccessPolicy is the policy the next admitted operation would get.
func (runtime *TaskRuntime) CurrentAccessPolicy() *ResolvedAccessPolicy {
	runtime.ensureOpen()
	return runtime.resolvedAccessPolicy()
}

// ModelLimits reports which credentials are busy and which requests wait.
func (runtime *TaskRuntime) ModelLimits() ModelSchedulerSnapshot {
	runtime.ensureOpen()
	return runtime.scheduler.Snapshot()
}

// ModelsInUse lists the model ids bound to tasks that have not finished.
func (runtime *TaskRuntime) ModelsInUse() []string {
	runtime.ensureOpen()
	seen := map[string]bool{}
	out := []string{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT DISTINCT i.model AS model FROM nodes n JOIN instances i ON i.id=n.instance_id JOIN tasks t ON t.id=n.task_id
    WHERE t.phase IN ('discussing','running','queued') AND n.status NOT IN ('succeeded','skipped') AND i.model IS NOT NULL`) {
		model := kernelString(row["model"])
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	for _, model := range KernelModelsInUse(runtime.kernel) {
		if model == "" || seen[model] {
			continue
		}
		seen[model] = true
		out = append(out, model)
	}
	return out
}

// InboxHistory reads the resolved questions across the conversation anchors.
func (runtime *TaskRuntime) InboxHistory(limit int) []map[string]any {
	runtime.ensureOpen()
	cap := limit
	if cap <= 0 {
		cap = 100
	}
	if cap > 500 {
		cap = 500
	}
	out := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT q.id,q.task_id AS taskId,q.node_id AS nodeId,q.kind,q.status,q.data,q.answer,q.owner,
    t.request,t.project_id AS projectId,t.conversation_id AS conversationId
    FROM questions q JOIN tasks t ON t.id=q.task_id
    WHERE q.status='resolved' AND q.owner='user'
    ORDER BY q.rowid DESC LIMIT ?`, cap) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		var answer any
		if row["answer"] != nil {
			if err := json.Unmarshal([]byte(kernelString(row["answer"])), &answer); err != nil {
				panic(err)
			}
		}
		out = append(out, map[string]any{
			"id":             kernelString(row["id"]),
			"taskId":         kernelString(row["taskId"]),
			"nodeId":         kernelString(row["nodeId"]),
			"kind":           kernelString(row["kind"]),
			"status":         kernelString(row["status"]),
			"owner":          kernelString(row["owner"]),
			"data":           data,
			"answer":         answer,
			"request":        kernelString(row["request"]),
			"projectId":      kernelString(row["projectId"]),
			"conversationId": row["conversationId"],
		})
	}
	return out
}

// GraphMessages reads the peer messages of one task.
func (runtime *TaskRuntime) GraphMessages(taskId string) []map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	out := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, `SELECT id,json_extract(data,'$.from') AS source,node_id AS target,text,created_at AS createdAt
    FROM node_entries WHERE task_id=? AND kind='chat'
    AND json_extract(data,'$.peer')=1 AND json_extract(data,'$.from') IS NOT NULL ORDER BY seq`, taskId) {
		out = append(out, map[string]any{
			"id":        kernelString(row["id"]),
			"source":    kernelString(row["source"]),
			"target":    kernelString(row["target"]),
			"text":      kernelString(row["text"]),
			"createdAt": kernelInt(row["createdAt"]),
		})
	}
	return out
}

// GraphLayout reads the stored layout of one graph revision.
func (runtime *TaskRuntime) GraphLayout(taskId string, revision int) map[string]any {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	epoch := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	row := kernelRow(runtime.kernel.Db, "SELECT topology,layout FROM kernel_graph_layouts WHERE task_id=? AND revision_version<=? ORDER BY revision_version DESC LIMIT 1", taskId, revision)
	var snapshot any
	if row != nil {
		snapshot = map[string]any{"topology": kernelString(row["topology"]), "layout": parseJSON(kernelString(row["layout"]))}
	}
	return map[string]any{"epoch": epoch, "snapshot": snapshot}
}

// SaveGraphLayout stores the layout of one graph revision.
func (runtime *TaskRuntime) SaveGraphLayout(taskId string, revision int, topology string, layout Json, epoch int64) bool {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	current := kernelInt(kernelRow(runtime.kernel.Db, "SELECT COALESCE(MAX(cursor),0) AS epoch FROM events WHERE task_id=? AND type='graph.layout_reset'", taskId)["epoch"])
	if current != epoch {
		return false
	}
	kernelExec(runtime.kernel.Db, "INSERT OR IGNORE INTO kernel_graph_layouts(task_id,revision_version,topology,layout) VALUES(?,?,?,?)",
		taskId, revision, topology, CanonicalJSON(layout))
	return true
}

// GraphModule explains one module of a graph.
func (runtime *TaskRuntime) GraphModule(taskId, moduleId string, query ModuleHistoryQuery) ModuleExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainModule(runtime.kernel, taskId, moduleId, query)
}

// GraphEdge explains one edge of a graph.
func (runtime *TaskRuntime) GraphEdge(taskId, edgeId string, query EdgeHistoryQuery) EdgeExplanation {
	runtime.ensureOpen()
	runtime.store.Task(taskId)
	return ExplainEdge(runtime.kernel, taskId, edgeId, nil, query)
}

// KernelGraph reads the native graph of one task.
func (runtime *TaskRuntime) KernelGraph(taskId string) any {
	runtime.ensureOpen()
	return KernelGraphView(runtime.kernel, taskId)
}

// NodeRun reads the node detail of one task.
func (runtime *TaskRuntime) NodeRun(taskId, nodeId string, query NodeEntryQuery) any {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodeRun(runtime.kernel, taskId, nodeId, query)
	}
	return NodeRun(runtime.store, taskId, nodeId, query)
}

// NodePrompt reads the recorded prompt of one node.
func (runtime *TaskRuntime) NodePrompt(taskId, nodeId string) NodePromptView {
	runtime.ensureOpen()
	if runtime.kernel.LatestRevision(taskId) != nil {
		return KernelNodePrompt(runtime.kernel, taskId, nodeId)
	}
	return NodePromptDetail(runtime.store, taskId, nodeId)
}

// AgentWorkspace reads the workspace identity of one node.
func (runtime *TaskRuntime) AgentWorkspace(taskId, nodeId string) *string {
	runtime.ensureOpen()
	row := kernelRow(runtime.store.Db, "SELECT instance_id,spec FROM nodes WHERE task_id=? AND id=?", taskId, nodeId)
	if row == nil {
		Raise("not_found", "Unknown node "+nodeId)
	}
	task := runtime.store.Task(taskId)
	var spec NodeSpec
	if err := json.Unmarshal([]byte(kernelString(row["spec"])), &spec); err != nil {
		panic(err)
	}
	var instanceId *string
	if row["instance_id"] != nil {
		value := kernelString(row["instance_id"])
		instanceId = &value
	}
	workspace := runtime.git.Workspace(taskId, instanceId, nodeId, spec.Kind, spec.Action)
	if workspace != nil {
		return workspace
	}
	project := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", task.ProjectID)
	if project == nil {
		return nil
	}
	root := kernelString(project["root"])
	return &root
}

// ProjectEntries reads the visible paths of one project.
func (runtime *TaskRuntime) ProjectEntries(projectId, query string, limit int) []ProjectPathEntry {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[projectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	return runtime.git.VisiblePaths(projectId, query, limit)
}

// SendNodeMessage hands a message to one node of a task.
func (runtime *TaskRuntime) SendNodeMessage(taskId, nodeId string, input NodeMessageInput) any {
	runtime.ensureOpen()
	receipt := SendKernelNodeMessage(runtime.kernel, taskId, nodeId, input, nil)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return receipt
}

// TaskRuntimePeerInput is one peer message.
type TaskRuntimePeerInput struct {
	To        string
	Text      string
	RequestId string
}

// SendPeerMessage hands a message to the peer of one node.
func (runtime *TaskRuntime) SendPeerMessage(taskId, from string, input TaskRuntimePeerInput) any {
	runtime.ensureOpen()
	nodeInput := NodeMessageInput{Text: input.Text, RequestID: input.RequestId}
	var receipt any
	if input.To == "main" {
		receipt = SendKernelMainMessage(runtime.kernel, taskId, from, nodeInput)
	} else {
		sender := from
		receipt = SendKernelNodeMessage(runtime.kernel, taskId, input.To, nodeInput, &sender)
	}
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return receipt
}

// ToolCallStats reads the durable tool-call telemetry.
func (runtime *TaskRuntime) ToolCallStats() map[string]any {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	return map[string]any{
		"generatedAt":   NowMillis(),
		"retentionDays": ToolCallRetentionDays,
		"stats":         runtime.store.ToolCallStats(),
	}
}

// SkillStats reads the skill usage telemetry.
func (runtime *TaskRuntime) SkillStats() map[string]any {
	runtime.ensureOpen()
	IngestToolCallSpools(runtime.store, runtime.stateDir)
	roots := []string{}
	for _, project := range runtime.configuredProjects() {
		if strings.TrimSpace(project.Root) != "" {
			roots = append(roots, project.Root)
		}
	}
	report := SkillUsage(SkillUsageInput{Store: runtime.store, ProjectRoots: roots, CapabilityRoot: runtime.catalogOpt.CapabilityRoot})
	return map[string]any{
		"generatedAt":   NowMillis(),
		"retentionDays": ToolCallRetentionDays,
		"report":        report,
	}
}

// PromoteSkill promotes one project skill into the capability library.
func (runtime *TaskRuntime) PromoteSkill(skillId string) any {
	runtime.ensureOpen()
	if runtime.catalogOpt.CapabilityRoot == "" {
		Raise("invalid_config", "Capability library is unavailable")
	}
	roots := []string{}
	for _, project := range runtime.configuredProjects() {
		if strings.TrimSpace(project.Root) == "" {
			continue
		}
		resolved, err := filepath.Abs(project.Root)
		if err != nil {
			resolved = project.Root
		}
		roots = append(roots, resolved)
	}
	return PromoteSkillFromProjects(roots, skillId, runtime.catalogOpt.CapabilityRoot)
}

// ClearToolCalls drops the recorded tool calls.
func (runtime *TaskRuntime) ClearToolCalls() map[string]any {
	runtime.ensureOpen()
	removed := runtime.store.ClearToolCalls()
	runtime.store.ForgetToolCallSpools()
	ClearToolCallSpools(runtime.stateDir)
	return map[string]any{"removed": removed}
}

// TaskRuntimeConversations is the conversation side of one runtime.
type TaskRuntimeConversations struct {
	runtime *TaskRuntime
}

// Conversations returns the conversation side of the runtime.
func (runtime *TaskRuntime) Conversations() *TaskRuntimeConversations {
	return &TaskRuntimeConversations{runtime: runtime}
}

// TaskRuntimeConversationInput starts one conversation.
type TaskRuntimeConversationInput struct {
	ProjectId     *string
	Title         *string
	Text          *string
	Attachments   []AttachmentInput
	Model         *string
	ThinkingLevel *string
	RequestId     string
}

// Create starts one conversation.
func (conversations *TaskRuntimeConversations) Create(input TaskRuntimeConversationInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversationId := graphUUID()
	attachments := CleanAttachments(input.Attachments)
	if input.ProjectId == nil {
		if err := os.MkdirAll(filepath.Join(runtime.stateDir, "conversations", conversationId), 0o700); err != nil {
			panic(err)
		}
	}
	result := runtime.store.Command("conversations", input.RequestId, map[string]any{
		"type":          "create",
		"projectId":     input.ProjectId,
		"title":         input.Title,
		"text":          input.Text,
		"attachments":   attachments,
		"model":         input.Model,
		"thinkingLevel": input.ThinkingLevel,
	}, func() any {
		text := ""
		if input.Text != nil {
			text = strings.TrimSpace(*input.Text)
		}
		if text == "" && len(attachments) == 0 {
			Raise("invalid_input", "A nonempty first message or attachment is required")
		}
		projectId := input.ProjectId
		workspaceProjectId := ""
		if projectId != nil {
			if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", *projectId) == nil {
				Raise("invalid_input", "A known project is required")
			}
			if !runtime.allowedProjects()[*projectId] {
				Raise("invalid_input", "The project is no longer part of the current configuration")
			}
			workspaceProjectId = *projectId
		} else {
			// The host-owned scratch workspace keeps an unbound conversation on
			// the ordinary project/grant path without granting any real root.
			root := filepath.Join(runtime.stateDir, "conversations", conversationId)
			kernelExec(runtime.store.Db, "INSERT INTO projects(id,root,grants) VALUES(?,?,?)", "conversation:"+conversationId, root, "[]")
			workspaceProjectId = "conversation:" + conversationId
		}
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		title := "新对话"
		if input.Title != nil && strings.TrimSpace(*input.Title) != "" {
			title = strings.TrimSpace(*input.Title)
		} else if text != "" {
			title = text
		}
		if len([]rune(title)) > 120 {
			title = string([]rune(title)[:120])
		}
		kernelExec(runtime.store.Db, "INSERT INTO tasks(id,project_id,request,requirement_version,phase,created_seq,conversation_id) VALUES(?,?,?,1,?,?,?)",
			taskId, workspaceProjectId, title, "chatting", sequence, conversationId)
		kernelExec(runtime.store.Db, "INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at) VALUES(?,?,?,?,?,?,?)",
			conversationId, projectId, workspaceProjectId, taskId, title, sequence, NowMillis())
		if runtime.master != nil && runtime.masterModel() != nil {
			runtime.createMasterNode(taskId)
			requestedModel := ""
			if input.Model != nil {
				requestedModel = strings.TrimSpace(*input.Model)
			}
			var selected *ConfiguredModel
			if requestedModel != "" {
				for _, entry := range runtime.liveConfiguredEntries() {
					if entry.Id == requestedModel {
						candidate := entry
						selected = &candidate
						break
					}
				}
				if selected == nil {
					Raise("model_unavailable", "The selected model is not configured")
				}
			}
			if selected != nil {
				master := kernelRow(runtime.store.Db, "SELECT spec,instance_id FROM nodes WHERE task_id=? AND id='master'", taskId)
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(master["spec"])), &spec); err != nil {
					panic(err)
				}
				spec.Model = &selected.Id
				kernelExec(runtime.store.Db, "UPDATE nodes SET spec=? WHERE task_id=? AND id='master'", CanonicalJSON(spec), taskId)
				kernelExec(runtime.store.Db, "UPDATE instances SET model=? WHERE id=?", selected.Id, kernelString(master["instance_id"]))
			}
			effective := selected
			if effective == nil {
				master := runtime.masterModel()
				if master != nil {
					for _, entry := range runtime.liveConfiguredEntries() {
						if entry.Id == *master {
							candidate := entry
							effective = &candidate
							break
						}
					}
				}
			}
			var requestedLevel *string
			if input.ThinkingLevel != nil {
				level := taskRuntimeAsThinkingLevel(*input.ThinkingLevel)
				requestedLevel = &level
			}
			if effective != nil {
				level := EffectiveThinkingLevel(effective.ModelEntry, requestedLevel)
				kernelExec(runtime.store.Db, "UPDATE conversations SET thinking_level=? WHERE id=?", string(level), conversationId)
			}
		}
		cursor := runtime.store.Event(taskId, "conversation.created", map[string]any{"conversationId": conversationId, "projectId": projectId, "title": title})
		var messageId any
		if text != "" || len(attachments) > 0 {
			data := any(nil)
			if len(attachments) > 0 {
				data = map[string]any{"attachments": attachments}
			}
			message := AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleUser,
				Kind:           "chat",
				Text:           text,
				State:          MessageStatePending,
				Data:           data,
			})
			messageId = message.Id
			if runtime.master != nil {
				// The node was just created, so it is already pending. The TypeScript
				// host wrote this status in the same synchronous block that created the
				// node, so it could never park a turn that was already running. The Go
				// host runs the creation and the dispatch on separate goroutines, so the
				// same write is guarded the way `say` guards it: a master that is
				// already preparing or running keeps its turn.
				row := kernelRow(runtime.store.Db, "SELECT status FROM nodes WHERE task_id=? AND id='master'", taskId)
				status := kernelString(row["status"])
				if status != "preparing" && status != "running" {
					kernelExec(runtime.store.Db, "UPDATE nodes SET status='pending' WHERE task_id=? AND id='master'", taskId)
				}
			}
			if message.Cursor != nil {
				cursor = *message.Cursor
			}
		}
		return map[string]any{
			"conversationId": conversationId,
			"taskId":         taskId,
			"title":          title,
			"messageId":      messageId,
			"cursor":         cursor,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// liveConfiguredEntries reads the configured models as configuration entries.
func (runtime *TaskRuntime) liveConfiguredEntries() []ConfiguredModel {
	if runtime.live != nil && runtime.live.Entries != nil {
		return runtime.live.Entries()
	}
	if runtime.models != nil {
		return runtime.models.Entries
	}
	return []ConfiguredModel{}
}

// createMasterNode records the master node of one task.
func (runtime *TaskRuntime) createMasterNode(taskId string) string {
	model := runtime.masterModel()
	definitionVersion := runtime.masterDefinitionVersion()
	if model == nil {
		Raise("models_missing", "No configured model for a master agent")
	}
	if definitionVersion == nil {
		Raise("definition_missing", "No configured definition for a master agent")
	}
	spec := NodeSpec{
		Id:                "master",
		Kind:              "agent",
		Action:            runtime.master.Action,
		DefinitionVersion: definitionVersion,
		Model:             model,
		Role:              taskRuntimeStringPtr("master"),
	}
	instanceId := graphUUID()
	kernelExec(runtime.store.Db, "INSERT INTO nodes(task_id,id,spec,instance_id) VALUES(?,?,?,?)", taskId, spec.Id, CanonicalJSON(spec), instanceId)
	runtime.insertInstance(instanceId, taskId, spec.Id, spec.DefinitionVersion, spec.Model)
	CreateActivation(runtime.store, taskId, spec.Id, 0)
	return instanceId
}

// List reads the conversation list.
func (conversations *TaskRuntimeConversations) List(archived bool) []map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	filter := "IS NULL"
	if archived {
		filter = "IS NOT NULL"
	}
	rows := kernelRows(runtime.store.Db, `SELECT c.id,c.title,c.project_id AS projectId,c.anchor_task_id AS anchorTaskId,c.created_at AS createdAt,
    c.archived_at AS archivedAt,
    (SELECT MAX(e.timestamp) FROM events e JOIN tasks t ON t.id=e.task_id WHERE t.conversation_id=c.id) AS updatedAt,
    (SELECT COUNT(*) FROM questions q JOIN tasks t ON t.id=q.task_id WHERE t.conversation_id=c.id AND q.status='open' AND q.owner='user') AS openQuestions,
    (SELECT COUNT(*) FROM tasks t WHERE t.conversation_id=c.id AND t.phase!='chatting') AS taskCount
    FROM conversations c WHERE c.archived_at `+filter+`
    ORDER BY c.created_seq`)
	out := []map[string]any{}
	for _, row := range rows {
		status := "chatting"
		switch {
		case kernelInt(row["openQuestions"]) > 0:
			status = "blocked"
		case kernelInt(row["taskCount"]) > 0:
			status = "executing"
		}
		out = append(out, map[string]any{
			"id":            kernelString(row["id"]),
			"title":         kernelString(row["title"]),
			"projectId":     row["projectId"],
			"anchorTaskId":  kernelString(row["anchorTaskId"]),
			"createdAt":     kernelInt(row["createdAt"]),
			"archivedAt":    row["archivedAt"],
			"updatedAt":     row["updatedAt"],
			"openQuestions": kernelInt(row["openQuestions"]),
			"taskCount":     kernelInt(row["taskCount"]),
			"status":        status,
		})
	}
	return out
}

// Archive archives one conversation.
func (conversations *TaskRuntimeConversations) Archive(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "archive"}, func() any {
		now := NowMillis()
		if conversation.ArchivedAt == nil {
			kernelExec(runtime.store.Db, "UPDATE conversations SET archived_at=? WHERE id=?", now, conversationId)
		}
		archivedAt := now
		if conversation.ArchivedAt != nil {
			archivedAt = *conversation.ArchivedAt
		}
		return map[string]any{
			"conversationId": conversationId,
			"archived":       true,
			"archivedAt":     archivedAt,
			"cursor":         runtime.store.Event(conversation.AnchorTaskId, "conversation.archived", map[string]any{"conversationId": conversationId}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Unarchive restores one archived conversation.
func (conversations *TaskRuntimeConversations) Unarchive(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "unarchive"}, func() any {
		if conversation.ArchivedAt != nil {
			kernelExec(runtime.store.Db, "UPDATE conversations SET archived_at=NULL WHERE id=?", conversationId)
		}
		return map[string]any{
			"conversationId": conversationId,
			"archived":       false,
			"archivedAt":     nil,
			"cursor":         runtime.store.Event(conversation.AnchorTaskId, "conversation.unarchived", map[string]any{"conversationId": conversationId}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeChatInput is one user message of a conversation.
type TaskRuntimeChatInput struct {
	Text        string
	RequestId   string
	Attachments []AttachmentInput
	Command     *string
	Source      Json
}

// Chat adds one user message to a conversation.
func (conversations *TaskRuntimeConversations) Chat(conversationId string, input TaskRuntimeChatInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	attachments := CleanAttachments(input.Attachments)
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{
		"type": "chat", "text": input.Text, "attachments": attachments, "command": input.Command, "source": input.Source,
	}, func() any {
		if strings.TrimSpace(input.Text) == "" && len(attachments) == 0 && input.Command == nil {
			Raise("invalid_input", "A nonempty message, attachment or command is required")
		}
		// The message is appended before the master is woken. The TypeScript host
		// did both in one synchronous block, so a turn could never start before the
		// message it has to answer existed. The Go host runs the command and the
		// dispatch on separate goroutines, so the message comes first. The state
		// reads the same status either way: recovering the master only moves a node
		// that was not busy, and a node that is not busy is pending in both readings.
		node := kernelRow(runtime.store.Db, "SELECT status FROM nodes WHERE task_id=? AND json_extract(spec,'$.role')='master'", conversation.AnchorTaskId)
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		state := "pending"
		if anchor.Paused != 0 || (node != nil && (kernelString(node["status"]) == "preparing" || kernelString(node["status"]) == "running" || kernelString(node["status"]) == "blocked")) {
			state = "queued"
		}
		data := any(nil)
		extra := map[string]any{}
		if len(attachments) > 0 {
			extra["attachments"] = attachments
		}
		if input.Command != nil {
			extra["command"] = *input.Command
		}
		if input.Source != nil {
			extra["source"] = input.Source
		}
		if len(extra) > 0 {
			data = extra
		}
		message := AppendMessage(runtime.store, MessageInput{
			ConversationID: conversationId,
			Role:           MessageRoleUser,
			Kind:           "chat",
			Text:           strings.TrimSpace(input.Text),
			State:          MessageState(state),
			Data:           data,
		})
		RecoverMaster(runtime.store, conversation.AnchorTaskId, "message")
		return map[string]any{
			"conversationId": conversationId,
			"messageId":      message.Id,
			"state":          state,
			"cursor":         message.Cursor,
			"pending":        state == "queued",
		}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Compact asks the master to compact the conversation context.
func (conversations *TaskRuntimeConversations) Compact(conversationId, requestId string) map[string]any {
	command := "compact"
	return conversations.Chat(conversationId, TaskRuntimeChatInput{
		Text:      "压缩当前会话上下文",
		RequestId: requestId,
		Command:   &command,
	})
}

// Bind binds one conversation to a project.
func (conversations *TaskRuntimeConversations) Bind(conversationId, projectId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if kernelRow(runtime.store.Db, "SELECT id FROM projects WHERE id=?", projectId) == nil {
		Raise("invalid_input", "A known project is required")
	}
	if !runtime.allowedProjects()[projectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	runtime.git.RequirePrepared(projectId)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{"type": "bind", "projectId": projectId}, func() any {
		previous := conversation.ProjectId
		if previous != nil && *previous == projectId {
			return map[string]any{"conversationId": conversationId, "taskId": conversation.AnchorTaskId, "changed": false, "cursor": nil}
		}
		kernelExec(runtime.store.Db, "UPDATE conversations SET project_id=? WHERE id=?", projectId, conversationId)
		kernelExec(runtime.store.Db, "UPDATE tasks SET project_id=? WHERE id=?", projectId, conversation.AnchorTaskId)
		invalidated := false
		if previous != nil {
			// A draft was investigated against the old project; switching the
			// project makes every existing draft unconfirmable, not just hidden.
			invalidated = true
			kernelExec(runtime.store.Db, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", conversation.AnchorTaskId)
			kernelExec(runtime.store.Db, "UPDATE conversations SET binding_since_seq=COALESCE((SELECT MAX(seq) FROM messages WHERE conversation_id=?),0) WHERE id=?", conversationId, conversationId)
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleSystem,
				Kind:           "project",
				Text:           "项目已从 " + *previous + " 变更为 " + projectId + "；旧草稿失效，请重新调查后生成新草稿。",
				State:          MessageStateDone,
			})
			runtime.store.Event(conversation.AnchorTaskId, "conversation.rebound", map[string]any{"from": *previous, "to": projectId})
		} else {
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversationId,
				Role:           MessageRoleSystem,
				Kind:           "project",
				Text:           "已绑定项目 " + projectId,
				State:          MessageStateDone,
			})
		}
		return map[string]any{
			"conversationId":    conversationId,
			"taskId":            conversation.AnchorTaskId,
			"changed":           true,
			"invalidatedDrafts": invalidated,
			"cursor":            runtime.store.Event(conversation.AnchorTaskId, "conversation.bound", map[string]any{"projectId": projectId, "previous": previous}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeConfirmInput confirms one draft of a conversation.
type TaskRuntimeConfirmInput struct {
	ProposalVersion int
	DraftRevision   int
	TargetBranch    string
	RequestId       string
	Attestation     *TaskRuntimeAttestation
}

// TaskRuntimeAttestation records who authorised a confirmation.
type TaskRuntimeAttestation struct {
	Actor       string
	OnBehalfOf  string
	Instruction string
}

// Confirm confirms one draft and creates the feature task it describes.
func (conversations *TaskRuntimeConversations) Confirm(conversationId string, input TaskRuntimeConfirmInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	bound := ConversationRowOf(runtime.store, conversationId)
	if bound.ProjectId == nil {
		Raise("invalid_input", "Bind a project before confirming a draft")
	}
	if strings.TrimSpace(input.TargetBranch) == "" {
		Raise("invalid_input", "A target branch is required")
	}
	runtime.git.RequireTargetBranch(*bound.ProjectId, input.TargetBranch)
	payload := map[string]any{
		"type": "confirm", "proposalVersion": input.ProposalVersion, "draftRevision": input.DraftRevision, "targetBranch": input.TargetBranch,
	}
	if input.Attestation != nil {
		payload["actor"] = input.Attestation.Actor
		payload["onBehalfOf"] = input.Attestation.OnBehalfOf
		payload["instruction"] = input.Attestation.Instruction
	}
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, payload, func() any {
		conversation := ConversationRowOf(runtime.store, conversationId)
		if conversation.ProjectId == nil {
			Raise("invalid_input", "Bind a project before confirming a draft")
		}
		if strings.TrimSpace(input.TargetBranch) == "" {
			Raise("invalid_input", "A target branch is required")
		}
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		row := kernelRow(runtime.store.Db, "SELECT requirement_version,spec,decision_snapshot,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil || row["archived_at"] != nil ||
			anchor.LatestProposal != int64(input.ProposalVersion) ||
			kernelInt(row["requirement_version"]) != anchor.RequirementVersion {
			Raise("stale_proposal", "Only the current draft on the current requirement can be confirmed")
		}
		if input.DraftRevision != int(kernelInt(row["draft_revision"])) {
			Raise("stale_proposal", "This draft changed after it was reviewed; read it again before confirming")
		}
		if kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?", conversationId, input.ProposalVersion) != nil {
			Raise("already_accepted", "This draft was already confirmed")
		}
		var proposal NativeProposal
		if err := json.Unmarshal([]byte(kernelString(row["spec"])), &proposal); err != nil {
			panic(err)
		}
		ValidateProposal(proposal)
		taskId := graphUUID()
		sequence := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks")["count"]) + 1
		active := kernelString(kernelRow(runtime.store.Db, "SELECT active_task FROM runtime")["active_task"])
		phase := "queued"
		if active == "" {
			phase = "running"
		}
		kernelExec(runtime.store.Db, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,accepted_proposal,target_branch,phase,created_seq,graph_version,conversation_id,decision_digest) VALUES(?,?,?,?,1,1,?,?,?,1,?,?)",
			taskId, *conversation.ProjectId, proposal.Summary, kernelInt(row["requirement_version"]), input.TargetBranch, phase, sequence, conversationId, row["decision_snapshot"])
		kernelExec(runtime.store.Db, "INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot) VALUES(?,?,?,?,?)",
			taskId, 1, kernelInt(row["requirement_version"]), kernelString(row["spec"]), row["decision_snapshot"])
		MaterializeGraph(runtime.kernel, taskId, ParseGraphDefinition(proposal.Definition), "Confirmed conversation draft")
		if phase == "running" {
			kernelExec(runtime.store.Db, "UPDATE runtime SET active_task=?", taskId)
		}
		kernelExec(runtime.store.Db, "UPDATE tasks SET requirement_version=requirement_version+1 WHERE id=?", anchor.ID)
		kernelExec(runtime.store.Db, "INSERT INTO conversation_acceptances(conversation_id,proposal_version,task_id,target_branch,accepted_at,draft_revision) VALUES(?,?,?,?,?,?)",
			conversationId, input.ProposalVersion, taskId, input.TargetBranch, NowMillis(), kernelInt(row["draft_revision"]))
		AppendMessage(runtime.store, MessageInput{
			ConversationID: conversationId,
			Role:           MessageRoleSystem,
			Kind:           "confirmed",
			Text:           "已确认草稿 v" + itoa(input.ProposalVersion) + "，创建功能任务，等待 main 投递输入（目标分支 " + input.TargetBranch + "）",
			Data:           map[string]any{"taskId": taskId, "proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch},
		})
		runtime.store.Event(taskId, "task.created", map[string]any{"request": proposal.Summary, "conversationId": conversationId, "configRevision": runtime.configRevision()})
		return map[string]any{
			"conversationId":  conversationId,
			"taskId":          taskId,
			"targetBranch":    input.TargetBranch,
			"proposalVersion": input.ProposalVersion,
			"draftRevision":   kernelInt(row["draft_revision"]),
			"cursor":          runtime.store.Event(anchor.ID, "conversation.confirmed", map[string]any{"taskId": taskId, "proposalVersion": input.ProposalVersion, "targetBranch": input.TargetBranch}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	taskId, _ := record["taskId"].(string)
	if taskId != "" {
		runtime.git.PrepareTask(taskId, input.TargetBranch)
		if NewKernelStore(runtime.store).LatestRevision(taskId) != nil {
			WakeMaster(runtime.store, WakeIntent{TaskID: taskId, Kind: "graph_ready", DedupeKey: taskId + ":ready", Data: map[string]any{"graphId": taskId}, HasData: true})
		}
	}
	return record
}

// TaskRuntimeDraftInput archives, restores or deletes one draft version.
type TaskRuntimeDraftInput struct {
	ProposalVersion int
	RequestId       string
}

// ArchiveDraft archives one draft version.
func (conversations *TaskRuntimeConversations) ArchiveDraft(conversationId string, input TaskRuntimeDraftInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{"type": "archive_draft", "proposalVersion": input.ProposalVersion}, func() any {
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		row := kernelRow(runtime.store.Db, "SELECT version,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil {
			Raise("not_found", "Proposal v"+itoa(input.ProposalVersion)+" was not found")
		}
		if row["archived_at"] == nil {
			kernelExec(runtime.store.Db, "UPDATE proposals SET archived_at=? WHERE task_id=? AND version=?", NowMillis(), anchor.ID, input.ProposalVersion)
		}
		return map[string]any{
			"conversationId":  conversationId,
			"proposalVersion": input.ProposalVersion,
			"archived":        true,
			"cursor":          runtime.store.Event(anchor.ID, "proposal.archived", map[string]any{"proposalVersion": input.ProposalVersion}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// RestoreDraft restores one archived draft version.
func (conversations *TaskRuntimeConversations) RestoreDraft(conversationId string, input TaskRuntimeDraftInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{"type": "restore_draft", "proposalVersion": input.ProposalVersion}, func() any {
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		row := kernelRow(runtime.store.Db, "SELECT version,requirement_version,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		if row == nil || row["deleted_at"] != nil {
			Raise("not_found", "Proposal v"+itoa(input.ProposalVersion)+" was not found")
		}
		kernelExec(runtime.store.Db, "UPDATE proposals SET archived_at=NULL WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		newer := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS n FROM proposals WHERE task_id=? AND version>? AND deleted_at IS NULL AND archived_at IS NULL", anchor.ID, input.ProposalVersion)["n"])
		if newer == 0 && kernelInt(row["requirement_version"]) == anchor.RequirementVersion {
			kernelExec(runtime.store.Db, "UPDATE tasks SET latest_proposal=? WHERE id=?", input.ProposalVersion, anchor.ID)
		}
		return map[string]any{
			"conversationId":  conversationId,
			"proposalVersion": input.ProposalVersion,
			"restored":        true,
			"cursor":          runtime.store.Event(anchor.ID, "proposal.restored", map[string]any{"proposalVersion": input.ProposalVersion}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// DeleteDraft deletes one draft version. The row stays as an invisible tombstone.
func (conversations *TaskRuntimeConversations) DeleteDraft(conversationId string, input TaskRuntimeDraftInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{"type": "delete_draft", "proposalVersion": input.ProposalVersion}, func() any {
		anchor := runtime.store.Task(conversation.AnchorTaskId)
		row := kernelRow(runtime.store.Db, "SELECT version,deleted_at FROM proposals WHERE task_id=? AND version=?", anchor.ID, input.ProposalVersion)
		if row == nil {
			Raise("not_found", "Proposal v"+itoa(input.ProposalVersion)+" was not found")
		}
		if row["deleted_at"] == nil {
			kernelExec(runtime.store.Db, "UPDATE proposals SET deleted_at=? WHERE task_id=? AND version=?", NowMillis(), anchor.ID, input.ProposalVersion)
		}
		return map[string]any{
			"conversationId":  conversationId,
			"proposalVersion": input.ProposalVersion,
			"deleted":         true,
			"cursor":          runtime.store.Event(anchor.ID, "proposal.deleted", map[string]any{"proposalVersion": input.ProposalVersion}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Pause pauses the anchor task of one conversation.
func (conversations *TaskRuntimeConversations) Pause(conversationId, requestId string) Receipt {
	conversation := ConversationRowOf(conversations.runtime.store, conversationId)
	return conversations.runtime.User().Task(conversation.AnchorTaskId).Pause(requestId)
}

// Resume resumes the anchor task of one conversation.
func (conversations *TaskRuntimeConversations) Resume(conversationId, requestId string) Receipt {
	conversation := ConversationRowOf(conversations.runtime.store, conversationId)
	return conversations.runtime.User().Task(conversation.AnchorTaskId).Resume(requestId)
}

// TaskRuntimeCancelInput cancels one queued message.
type TaskRuntimeCancelInput struct {
	MessageId string
	RequestId string
}

// CancelMessage drops one still-queued message of a conversation.
func (conversations *TaskRuntimeConversations) CancelMessage(conversationId string, input TaskRuntimeCancelInput) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	if strings.TrimSpace(input.MessageId) == "" {
		Raise("invalid_input", "A messageId is required")
	}
	result := runtime.store.Command("conversation:"+conversationId, input.RequestId, map[string]any{
		"type": "cancel_message", "messageId": input.MessageId,
	}, func() any {
		cancelled := CancelQueuedMessage(runtime.store, conversationId, input.MessageId)
		var cursor any
		if cancelled.Changed {
			cursor = runtime.store.Event(conversation.AnchorTaskId, "message.cancelled", map[string]any{"messageId": input.MessageId})
		}
		return map[string]any{
			"conversationId": conversationId,
			"messageId":      input.MessageId,
			"state":          cancelled.State,
			"cancelled":      cancelled.Cancelled,
			"cursor":         cursor,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Steer hands the queued messages of a conversation to the live master turn.
func (conversations *TaskRuntimeConversations) Steer(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	active := kernelRow(runtime.store.Db, `
        SELECT o.id,o.spec
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `, conversationId)
	messages := PendingMessages(runtime.store, conversationId, 50)
	if len(messages) == 0 {
		return map[string]any{"conversationId": conversationId, "state": "empty", "steered": 0, "cursor": nil}
	}
	if active == nil {
		return map[string]any{"conversationId": conversationId, "state": "queued", "steered": 0, "cursor": nil}
	}
	var operation Operation
	if err := json.Unmarshal([]byte(kernelString(active["spec"])), &operation); err != nil {
		panic(err)
	}
	parts := []string{}
	for _, message := range messages {
		text := taskRuntimeSteeringText(message)
		if text != "" {
			parts = append(parts, text)
		}
	}
	combined := strings.Join(parts, "\n\n")
	if combined == "" {
		Raise("invalid_input", "Queued messages do not contain steerable text")
	}
	steered := runtime.execution.Interrupt(kernelString(active["id"]), &combined)
	ids := []string{}
	for _, message := range messages {
		ids = append(ids, message.Id)
	}
	receipt := runtime.store.Transaction(func() any {
		ordinal := -1
		if steered != nil {
			ordinal = int(*steered)
		}
		DeliverMessages(runtime.store, kernelString(active["id"]), operation.Attempt, messages, ordinal)
		cursor := runtime.store.Event(conversation.AnchorTaskId, "message.steered", map[string]any{
			"operationId": kernelString(active["id"]),
			"messageIds":  ids,
			"requestId":   requestId,
		})
		return map[string]any{"conversationId": conversationId, "state": "steered", "steered": len(ids), "cursor": cursor}
	})
	record, _ := jsonRecord(receipt)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// Interrupt stops the live master turn of a conversation.
func (conversations *TaskRuntimeConversations) Interrupt(conversationId, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	active := kernelRow(runtime.store.Db, `
        SELECT o.id
        FROM operations o
        JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
        JOIN tasks t ON t.id=o.task_id
        WHERE t.conversation_id=? AND json_extract(n.spec,'$.role')='master'
          AND o.state='dispatched' AND o.worker_active=1
        ORDER BY o.rowid DESC LIMIT 1
      `, conversationId)
	if active == nil {
		return map[string]any{"conversationId": conversationId, "state": "idle", "requestId": requestId}
	}
	runtime.execution.Interrupt(kernelString(active["id"]), nil)
	return map[string]any{"conversationId": conversationId, "state": "interrupted", "requestId": requestId}
}

// messageQueryOf narrows a node-entry query down to the message window the
// conversation transcript understands. The entry selector has no meaning for
// messages, so it is dropped, exactly like the TypeScript source did.
func messageQueryOf(query NodeEntryQuery) MessageQuery {
	converted := MessageQuery{}
	if query.After != nil {
		after := int(*query.After)
		converted.After = &after
	}
	if query.Before != nil {
		before := int(*query.Before)
		converted.Before = &before
	}
	if query.Limit != nil {
		limit := int(*query.Limit)
		converted.Limit = &limit
	}
	return converted
}

// View reads the full projection of one conversation.
func (conversations *TaskRuntimeConversations) View(conversationId string, query NodeEntryQuery) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	conversation := ConversationRowOf(runtime.store, conversationId)
	anchor := runtime.store.Task(conversation.AnchorTaskId)
	master := kernelRow(runtime.store.Db, "SELECT n.status,i.used,i.budget,i.unlimited,COALESCE(i.model,json_extract(n.spec,'$.model')) AS model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'", conversation.AnchorTaskId)
	accepted := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT proposal_version,task_id,target_branch,accepted_at,draft_revision FROM conversation_acceptances WHERE conversation_id=? ORDER BY accepted_at", conversationId) {
		accepted = append(accepted, map[string]any{
			"proposalVersion": kernelInt(row["proposal_version"]),
			"taskId":          kernelString(row["task_id"]),
			"targetBranch":    kernelString(row["target_branch"]),
			"acceptedAt":      kernelInt(row["accepted_at"]),
			"draftRevision":   row["draft_revision"],
		})
	}
	proposal := any(nil)
	if anchor.LatestProposal > 0 {
		proposal = taskRuntimeConversationProposal(runtime.store, anchor.ID, int(anchor.LatestProposal), int(anchor.RequirementVersion), false)
	}
	proposalRows := taskRuntimeProposalRows(runtime.store, anchor.ID)
	proposalHistory := []map[string]any{}
	archivedProposals := []map[string]any{}
	for _, row := range proposalRows {
		if row.DeletedAt != nil {
			continue
		}
		entry := map[string]any{
			"version":            row.Version,
			"requirementVersion": row.RequirementVersion,
			"stale":              row.RequirementVersion != int(anchor.RequirementVersion),
			"draftRevision":      row.DraftRevision,
			"draftDigest":        ContentDigest(row.Spec),
		}
		if row.DraftDigest != nil {
			entry["draftDigest"] = *row.DraftDigest
		}
		if row.ArchivedAt != nil {
			archivedProposals = append(archivedProposals, entry)
			continue
		}
		proposalHistory = append(proposalHistory, entry)
	}
	anchorQuestions := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT id,node_id,operation_id,kind,status,data,answer,owner FROM questions WHERE task_id=? ORDER BY rowid", conversation.AnchorTaskId) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		var answer any
		if row["answer"] != nil {
			if err := json.Unmarshal([]byte(kernelString(row["answer"])), &answer); err != nil {
				panic(err)
			}
		}
		anchorQuestions = append(anchorQuestions, map[string]any{
			"id":          kernelString(row["id"]),
			"nodeId":      kernelString(row["node_id"]),
			"operationId": row["operation_id"],
			"kind":        kernelString(row["kind"]),
			"status":      kernelString(row["status"]),
			"owner":       kernelString(row["owner"]),
			"data":        data,
			"answer":      answer,
			"taskId":      conversation.AnchorTaskId,
		})
	}
	tasks := []map[string]any{}
	taskCosts := []CostSummary{}
	taskUsed := int64(0)
	taskBudget := int64(0)
	taskUnlimited := false
	unknownUsagePending := false
	for _, row := range kernelRows(runtime.store.Db, "SELECT id,request,phase,paused,target_branch,accepted_proposal,integration_sha,(SELECT MIN(timestamp) FROM events WHERE task_id=tasks.id) AS createdAt FROM tasks WHERE conversation_id=? AND phase!='chatting' ORDER BY created_seq", conversationId) {
		taskId := kernelString(row["id"])
		openQuestions := []map[string]any{}
		internalProblems := 0
		for _, question := range kernelRows(runtime.store.Db, "SELECT id,node_id,kind,status,data,owner FROM questions WHERE task_id=? ORDER BY rowid", taskId) {
			if kernelString(question["status"]) != "open" {
				continue
			}
			if kernelString(question["kind"]) == "unknown_usage" {
				unknownUsagePending = true
			}
			if kernelString(question["owner"]) == "main" {
				internalProblems++
				continue
			}
			if kernelString(question["owner"]) != "user" {
				continue
			}
			var data any
			if err := json.Unmarshal([]byte(kernelString(question["data"])), &data); err != nil {
				panic(err)
			}
			openQuestions = append(openQuestions, map[string]any{
				"id":     kernelString(question["id"]),
				"nodeId": kernelString(question["node_id"]),
				"kind":   kernelString(question["kind"]),
				"data":   data,
			})
		}
		nodes := []any{}
		if runtime.kernel.LatestRevision(taskId) == nil {
			for _, node := range kernelRows(runtime.store.Db, "SELECT n.id,n.spec,n.status,n.stall_count,n.output_version,i.used,i.budget,i.unlimited,i.model,i.definition_version FROM nodes n LEFT JOIN instances i ON i.id=n.instance_id WHERE n.task_id=? ORDER BY n.rowid", taskId) {
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err != nil {
					panic(err)
				}
				var role any
				if spec.Role != nil {
					role = *spec.Role
				}
				unlimited := kernelInt(node["unlimited"]) != 0
				var budget any
				if !unlimited {
					budget = node["budget"]
				}
				taskUsed += kernelInt(node["used"])
				if unlimited {
					taskUnlimited = true
				} else {
					taskBudget += kernelInt(node["budget"])
				}
				nodes = append(nodes, map[string]any{
					"id":                kernelString(node["id"]),
					"kind":              spec.Kind,
					"role":              role,
					"status":            kernelString(node["status"]),
					"used":              node["used"],
					"unlimited":         unlimited,
					"budget":            budget,
					"model":             node["model"],
					"definitionVersion": node["definition_version"],
					"stallCount":        kernelInt(node["stall_count"]),
					"outputVersion":     kernelInt(node["output_version"]),
				})
			}
		} else {
			nodes = append(nodes, KernelConversationNodes(runtime.kernel, taskId)...)
			for _, node := range KernelConversationNodes(runtime.kernel, taskId) {
				entry := asMap(node)
				if entry == nil {
					continue
				}
				taskUsed += kernelInt(entry["used"])
				if entry["unlimited"] == true {
					taskUnlimited = true
				} else {
					taskBudget += kernelInt(entry["budget"])
				}
			}
		}
		evidence := []any{}
		for _, item := range kernelRows(runtime.store.Db, "SELECT acceptance_id,valid FROM evidence WHERE task_id=? ORDER BY rowid", taskId) {
			evidence = append(evidence, map[string]any{
				"acceptanceId": kernelString(item["acceptance_id"]),
				"valid":        kernelInt(item["valid"]) != 0,
			})
		}
		cost := taskRuntimeTaskCost(runtime, taskId)
		taskCosts = append(taskCosts, cost)
		status := kernelString(row["phase"])
		if kernelInt(row["paused"]) != 0 {
			status = "paused"
		} else if len(openQuestions) > 0 {
			status = "blocked"
		}
		tasks = append(tasks, map[string]any{
			"id":                      taskId,
			"request":                 kernelString(row["request"]),
			"phase":                   kernelString(row["phase"]),
			"paused":                  kernelInt(row["paused"]) != 0,
			"createdAt":               row["createdAt"],
			"status":                  status,
			"targetBranch":            row["target_branch"],
			"acceptedProposalVersion": row["accepted_proposal"],
			"integrationSha":          row["integration_sha"],
			"openQuestions":           openQuestions,
			"internalProblemCount":    internalProblems,
			"nodes":                   nodes,
			"cost":                    cost,
			"evidence":                evidence,
		})
	}
	var projectRoot any
	if conversation.ProjectId != nil {
		project := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", *conversation.ProjectId)
		if project != nil {
			projectRoot = kernelString(project["root"])
		}
	}
	messageCount := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM messages WHERE conversation_id=?", conversationId)["count"])
	continuations := []map[string]any{}
	for _, row := range kernelRows(runtime.store.Db, "SELECT operation_id AS operationId,resumed_operation_id AS resumedOperationId FROM rsi_continuations WHERE task_id=?", conversation.AnchorTaskId) {
		continuations = append(continuations, map[string]any{
			"operationId":        kernelString(row["operationId"]),
			"resumedOperationId": row["resumedOperationId"],
		})
	}
	// Unknown usage can be pending reconciliation before any priced invocation
	// exists (scripted adapters, recovery before settle); an open unknown_usage
	// question is authoritative that the cost is not known.
	masterUnknown := false
	masterQuestions := []map[string]any{}
	for _, question := range anchorQuestions {
		if kernelString(question["kind"]) == "unknown_usage" && kernelString(question["status"]) == "open" {
			masterUnknown = true
		}
		if kernelString(question["status"]) == "open" && kernelString(question["owner"]) == "user" {
			masterQuestions = append(masterQuestions, question)
		}
	}
	ledgerCost := taskRuntimeTaskCost(runtime, conversation.AnchorTaskId)
	masterCost := ledgerCost
	if masterUnknown && !ledgerCost.Unknown {
		masterCost.Unknown = true
	}
	merged := MergeCosts(append([]CostSummary{masterCost}, taskCosts...))
	if masterUnknown || unknownUsagePending {
		merged.Unknown = true
	}
	masterUsed := int64(0)
	masterBudget := int64(0)
	masterUnlimited := false
	if master != nil {
		masterUsed = kernelInt(master["used"])
		masterUnlimited = kernelInt(master["unlimited"]) != 0
		if !masterUnlimited {
			masterBudget = kernelInt(master["budget"])
		}
	}
	used := masterUsed + taskUsed
	anyUnlimited := masterUnlimited || taskUnlimited
	var budget any
	if !anyUnlimited {
		budget = masterBudget + taskBudget
	}
	knownMasterUsage := ConversationMasterUsage(runtime.store, conversationId)
	var contextLimit any
	var masterModel any
	if master != nil {
		masterModel = master["model"]
	}
	if model, ok := masterModel.(string); ok && model != "" {
		for _, entry := range runtime.liveEntries() {
			if entry.Id == model {
				contextLimit = entry.ContextWindow
				break
			}
		}
	}
	var cacheHitRate any
	if knownMasterUsage.CacheInput > 0 {
		cacheHitRate = float64(knownMasterUsage.CachedInput) / float64(knownMasterUsage.CacheInput)
	}
	var contextPercent any
	if knownMasterUsage.ContextTokens != nil {
		if limit, ok := contextLimit.(int64); ok && limit > 0 {
			percent := float64(*knownMasterUsage.ContextTokens) / float64(limit) * 100
			if percent > 100 {
				percent = 100
			}
			contextPercent = percent
		}
	}
	telemetry := map[string]any{
		"model":          masterModel,
		"thinkingLevel":  conversation.ThinkingLevel,
		"cacheHitRate":   cacheHitRate,
		"cachedInput":    knownMasterUsage.CachedInput,
		"cacheInput":     knownMasterUsage.CacheInput,
		"contextTokens":  knownMasterUsage.ContextTokens,
		"contextLimit":   contextLimit,
		"contextPercent": contextPercent,
	}
	var masterView any
	if master != nil {
		masterView = map[string]any{
			"nodeId":            "master",
			"status":            kernelString(master["status"]),
			"model":             master["model"],
			"used":              master["used"],
			"unlimited":         masterUnlimited,
			"budget":            master["budget"],
			"definitionVersion": master["definition_version"],
			"cost":              masterCost,
			"questions":         masterQuestions,
		}
	}
	view := map[string]any{
		"id":                 conversation.Id,
		"title":              conversation.Title,
		"projectId":          conversation.ProjectId,
		"projectRoot":        projectRoot,
		"archived":           conversation.ArchivedAt != nil,
		"archivedAt":         conversation.ArchivedAt,
		"paused":             anchor.Paused != 0,
		"workspaceProjectId": conversation.WorkspaceProjectId,
		"anchorTaskId":       conversation.AnchorTaskId,
		"createdAt":          conversation.CreatedAt,
		"requirementVersion": anchor.RequirementVersion,
		"eventCursor":        kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
		"messages":           ListMessages(runtime.store, conversationId, messageQueryOf(query)),
		"messageCount":       messageCount,
		"streams":            ConversationStreams(runtime.store, conversationId),
		"continuations":      continuations,
		"questions":          anchorQuestions,
		"proposal":           proposal,
		"proposalHistory":    proposalHistory,
		"archivedProposals":  archivedProposals,
		"accepted":           accepted,
		"master":             masterView,
		"telemetry":          telemetry,
		"cost":               merged,
		"usage":              map[string]any{"used": used, "budget": budget, "unlimited": anyUnlimited},
		"tasks":              tasks,
		"cursor":             kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(cursor),0) AS cursor FROM events")["cursor"]),
	}
	return view
}

// taskRuntimeTaskCost sums the cost receipts of one task. The kernel provider
// calls are native sends without a frozen monetary price receipt yet, so a
// missing price cannot mean free.
func taskRuntimeTaskCost(runtime *TaskRuntime, taskId string) CostSummary {
	costs := []any{}
	for _, row := range InvocationRows(runtime.store, taskId) {
		costs = append(costs, row.Cost)
	}
	for range runtime.kernel.ProviderCalls(taskId) {
		costs = append(costs, map[string]any{"unknown": true})
	}
	return SumCosts(costs)
}

// Proposal reads one proposal version of a conversation.
func (conversations *TaskRuntimeConversations) Proposal(conversationId string, version int) any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	if version < 1 {
		Raise("invalid_input", "A positive proposal version is required")
	}
	conversation := ConversationRowOf(runtime.store, conversationId)
	anchor := runtime.store.Task(conversation.AnchorTaskId)
	proposal := taskRuntimeConversationProposal(runtime.store, anchor.ID, version, int(anchor.RequirementVersion), true)
	if proposal == nil {
		Raise("not_found", "Proposal v"+itoa(version)+" was not found")
	}
	return proposal
}

// Events reads the events of one conversation.
func (conversations *TaskRuntimeConversations) Events(conversationId string, after int, limit int) []TaskUpdate {
	runtime := conversations.runtime
	runtime.ensureOpen()
	cap := limit
	if cap <= 0 {
		cap = 200
	}
	if cap > 500 {
		cap = 500
	}
	ids := runtime.conversationTaskIds(conversationId)
	out := []TaskUpdate{}
	for _, row := range runtime.conversationEventRows(ids, after, cap) {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, TaskUpdate{
			Cursor:    int(kernelInt(row["cursor"])),
			TaskId:    kernelString(row["task_id"]),
			Type:      kernelString(row["type"]),
			Data:      data,
			Timestamp: kernelInt(row["timestamp"]),
		})
	}
	return out
}

// conversationTaskIds is the anchor plus every feature task of one conversation.
func (runtime *TaskRuntime) conversationTaskIds(conversationId string) []string {
	anchor := ConversationRowOf(runtime.store, conversationId).AnchorTaskId
	seen := map[string]bool{}
	ids := []string{}
	for _, id := range []string{anchor} {
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	for _, row := range kernelRows(runtime.store.Db, "SELECT id FROM tasks WHERE conversation_id=?", conversationId) {
		id := kernelString(row["id"])
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		ids = append(ids, id)
	}
	return ids
}

// conversationEventRows reads the events of several tasks.
func (runtime *TaskRuntime) conversationEventRows(ids []string, after int, limit int) []map[string]any {
	if len(ids) == 0 {
		return nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(ids)), ",")
	params := []any{}
	for _, id := range ids {
		params = append(params, id)
	}
	params = append(params, after, limit)
	return kernelRows(runtime.store.Db, "SELECT cursor,task_id,type,data,timestamp FROM events WHERE task_id IN ("+placeholders+") AND cursor>? ORDER BY cursor LIMIT ?", params...)
}

// Watch streams the events of one conversation.
func (conversations *TaskRuntimeConversations) Watch(conversationId string, after int) TaskWatch {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	if after < 0 {
		Raise("invalid_cursor", "Invalid event cursor")
	}
	stop := make(chan struct{})
	var once sync.Once
	ctx, cancel := context.WithCancel(context.Background())
	cursor := after
	pending := []TaskUpdate{}
	return TaskWatch{
		Next: func() (TaskUpdate, bool) {
			for {
				select {
				case <-stop:
					return TaskUpdate{}, false
				default:
				}
				if len(pending) > 0 {
					update := pending[0]
					pending = pending[1:]
					return update, true
				}
				// The stream covers the anchor and every task the conversation created,
				// re-reading the task set each iteration so a new task is included
				// without reconnecting. The global event cursor stays monotonic.
				wake := runtime.store.WaitForChange(ctx)
				rows := runtime.conversationEventRows(runtime.conversationTaskIds(conversationId), cursor, 100)
				if len(rows) > 0 {
					wake.Cancel()
					for _, row := range rows {
						cursor = int(kernelInt(row["cursor"]))
						var data any
						if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
							panic(err)
						}
						pending = append(pending, TaskUpdate{
							Cursor:    cursor,
							TaskId:    kernelString(row["task_id"]),
							Type:      kernelString(row["type"]),
							Data:      data,
							Timestamp: kernelInt(row["timestamp"]),
						})
					}
					continue
				}
				select {
				case <-wake.Promise:
				case <-time.After(250 * time.Millisecond):
				case <-stop:
					return TaskUpdate{}, false
				}
				wake.Cancel()
			}
		},
		Stop: func() { once.Do(func() { close(stop); cancel() }) },
	}
}

// Attachment reads one image attachment of a message.
func (conversations *TaskRuntimeConversations) Attachment(messageId string, index int) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	if index < 0 {
		Raise("not_found", "Attachment not found")
	}
	row := kernelRow(runtime.store.Db, "SELECT data FROM messages WHERE id=?", messageId)
	if row == nil {
		Raise("not_found", "Image attachment not found")
	}
	attachment := taskRuntimeAttachmentAt(row, index)
	if attachment == nil {
		Raise("not_found", "Image attachment not found")
	}
	return map[string]any{"type": attachment.Type, "bytes": attachment.Data}
}

// taskRuntimeAttachmentAt reads one attachment of a message payload.
func taskRuntimeAttachmentAt(row map[string]any, index int) *AttachmentInput {
	if row["data"] == nil {
		return nil
	}
	var data map[string]any
	if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
		return nil
	}
	attachments, ok := data["attachments"].([]any)
	if !ok || index >= len(attachments) {
		return nil
	}
	record, ok := jsonRecord(attachments[index])
	if !ok {
		return nil
	}
	kind, _ := record["type"].(string)
	if kind != "image/png" && kind != "image/jpeg" && kind != "image/webp" && kind != "image/gif" {
		return nil
	}
	encoded, ok := record["data"].(string)
	if !ok {
		return nil
	}
	size := int64(0)
	if value, ok := record["size"].(float64); ok {
		size = int64(value)
	}
	name, _ := record["name"].(string)
	text, _ := record["text"].(string)
	return &AttachmentInput{Name: name, Type: kind, Size: size, Text: text, Data: &encoded}
}

// History reads the message history of one conversation.
func (conversations *TaskRuntimeConversations) History(conversationId string, query NodeEntryQuery) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	return map[string]any{"messages": ListMessages(runtime.store, conversationId, messageQueryOf(query))}
}

// SelectModel changes the model of one conversation.
func (conversations *TaskRuntimeConversations) SelectModel(conversationId, model, thinkingLevel, requestId string) map[string]any {
	runtime := conversations.runtime
	runtime.ensureOpen()
	ConversationRowOf(runtime.store, conversationId)
	if strings.TrimSpace(model) == "" {
		Raise("invalid_input", "A model is required")
	}
	requested := taskRuntimeAsThinkingLevel(thinkingLevel)
	result := runtime.store.Command("conversation:"+conversationId, requestId, map[string]any{
		"type": "select_model", "model": strings.TrimSpace(model), "thinkingLevel": requested,
	}, func() any {
		var entry *ConfiguredModel
		for _, candidate := range runtime.liveConfiguredEntries() {
			if candidate.Id == strings.TrimSpace(model) {
				found := candidate
				entry = &found
				break
			}
		}
		if entry == nil {
			Raise("model_unavailable", "The selected model is not configured")
		}
		level := EffectiveThinkingLevel(entry.ModelEntry, &requested)
		anchor := ConversationRowOf(runtime.store, conversationId).AnchorTaskId
		master := kernelRow(runtime.store.Db, `
          SELECT n.instance_id,n.spec
          FROM nodes n
          WHERE n.task_id=? AND json_extract(n.spec,'$.role')='master'
        `, anchor)
		if master == nil || kernelString(master["instance_id"]) == "" {
			Raise("model_unavailable", "This conversation has no master Agent instance")
		}
		var spec NodeSpec
		if err := json.Unmarshal([]byte(kernelString(master["spec"])), &spec); err != nil {
			panic(err)
		}
		currentLevel := ConversationRowOf(runtime.store, conversationId).ThinkingLevel
		changed := (spec.Model == nil || *spec.Model != entry.Id) || currentLevel == nil || *currentLevel != string(level)
		spec.Model = &entry.Id
		kernelExec(runtime.store.Db, "UPDATE nodes SET spec=? WHERE task_id=? AND id=?", CanonicalJSON(spec), anchor, spec.Id)
		kernelExec(runtime.store.Db, "UPDATE instances SET model=? WHERE id=?", entry.Id, kernelString(master["instance_id"]))
		kernelExec(runtime.store.Db, "UPDATE conversations SET thinking_level=? WHERE id=?", string(level), conversationId)
		if changed {
			runtime.store.Event(anchor, "conversation.model_selected", map[string]any{"model": entry.Id, "thinkingLevel": string(level)})
		}
		return map[string]any{
			"conversationId": conversationId,
			"model":          entry.Id,
			"thinkingLevel":  string(level),
			"changed":        changed,
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeSupervisor is the control surface the main Agent sees.
type TaskRuntimeSupervisor struct {
	runtime *TaskRuntime
	taskId  string
}

// Supervisor returns the control surface of one task.
func (runtime *TaskRuntime) Supervisor(taskId string) *TaskRuntimeSupervisor {
	return &TaskRuntimeSupervisor{runtime: runtime, taskId: taskId}
}

// TaskRuntimeControlInput is one control action of the main Agent.
type TaskRuntimeControlInput struct {
	Action    string
	TaskId    *string
	NodeId    *string
	Text      *string
	Tokens    *int64
	Reason    *string
	RequestId string
}

// ControlTask applies one control action of the main Agent.
func (supervisor *TaskRuntimeSupervisor) ControlTask(input TaskRuntimeControlInput) any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if input.RequestId == "" || len(input.RequestId) > 200 {
		Raise("invalid_input", "A bounded requestId is required")
	}
	target := supervisor.controlTarget(input.TaskId)
	scope := "supervisor:" + supervisor.taskId
	switch input.Action {
	case "pause", "resume":
		paused := input.Action == "pause"
		stoppedMaster := false
		receipt := runtime.store.Command(scope, input.RequestId, map[string]any{"type": input.Action, "taskId": target}, func() any {
			pausedValue := 0
			if paused {
				pausedValue = 1
			}
			kernelExec(runtime.store.Db, "UPDATE tasks SET paused=? WHERE id=?", pausedValue, target)
			if paused {
				OpenPause(runtime.store, target)
				active := kernelRow(runtime.store.Db, `SELECT o.id FROM operations o
                  JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
                  WHERE o.task_id=? AND json_extract(n.spec,'$.role')='master'
                    AND o.state='dispatched' AND o.worker_active=1 ORDER BY o.rowid DESC LIMIT 1`, target)
				if active != nil {
					stoppedMaster = AwaitPauseContinuation(runtime.store, input.RequestId, target, kernelString(active["id"]))
				}
			} else {
				ClosePause(runtime.store, target)
				ResumePauseContinuations(runtime.store, target)
			}
			eventType := "task.resumed"
			if paused {
				eventType = "task.pause_requested"
			}
			return map[string]any{
				"taskId": target,
				"cursor": runtime.store.Event(target, eventType, map[string]any{"actor": "agent", "reason": reasonValue(input.Reason)}),
			}
		})
		if paused && stoppedMaster {
			runtime.execution.StopActiveMasterTurns(target)
		} else if !paused && runtime.autoWake {
			runtime.execution.Kick()
		}
		return receipt
	case "abandon":
		reason := ""
		if input.Reason != nil {
			reason = strings.TrimSpace(*input.Reason)
		}
		if reason == "" {
			Raise("invalid_input", "Abandoning a task needs a recorded reason")
		}
		return runtime.store.Command(scope, input.RequestId, map[string]any{"type": "abandon", "taskId": target, "reason": reason}, func() any {
			return map[string]any{
				"taskId": target,
				"cursor": runtime.execution.Abandon(target, &reason, true),
			}
		})
	case "set_budget":
		nodeId := ""
		if input.NodeId != nil {
			nodeId = strings.TrimSpace(*input.NodeId)
		}
		if nodeId == "" {
			Raise("invalid_input", "set_budget needs the node whose budget changes")
		}
		if input.Tokens == nil {
			Raise("invalid_input", "set_budget needs tokens: a positive integer or null for unlimited")
		}
		if *input.Tokens <= 0 {
			Raise("invalid_input", "Budget must be a positive integer or null")
		}
		if runtime.kernel.LatestRevision(target) != nil {
			Raise("invalid_graph", "Native node budgets are declared with graph_patch; only the user can change authorization")
		}
		specRow := kernelRow(runtime.store.Db, "SELECT spec FROM nodes WHERE task_id=? AND id=?", target, nodeId)
		action := ""
		if specRow != nil {
			var spec map[string]any
			if err := json.Unmarshal([]byte(kernelString(specRow["spec"])), &spec); err == nil {
				action, _ = spec["action"].(string)
			}
		}
		reservation := runtime.execution.ReserveTokensFor(action)
		var warning *string
		if input.Tokens != nil && reservation != nil && *input.Tokens < int64(*reservation) {
			text := "这个上限（" + itoa(int(*input.Tokens)) + "）低于该节点一次派发所需的预留 " + itoa(*reservation) + " tokens：它下一次派发（包括正在跑的这一回合）会被预算挡住并停下来问人。"
			warning = &text
		}
		return runtime.store.Command(scope, input.RequestId, map[string]any{"type": "set_budget", "taskId": target, "nodeId": nodeId, "tokens": input.Tokens}, func() any {
			instance := kernelRow(runtime.store.Db, "SELECT id FROM instances WHERE task_id=? AND node_id=?", target, nodeId)
			if instance == nil {
				Raise("not_found", "Unknown agent node")
			}
			SetBudget(runtime.store, kernelString(instance["id"]), input.Tokens)
			kernelExec(runtime.store.Db, "UPDATE questions SET status='resolved',answer=? WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'",
				CanonicalJSON(map[string]any{"type": "set_budget", "tokens": input.Tokens}), target, nodeId)
			event := map[string]any{"nodeId": nodeId, "tokens": input.Tokens, "actor": "agent"}
			if warning != nil {
				event["warning"] = *warning
			}
			out := map[string]any{"taskId": target, "nodeId": nodeId, "tokens": input.Tokens, "cursor": runtime.store.Event(target, "instance.budget_changed", event)}
			if warning != nil {
				out["warning"] = *warning
			}
			return out
		})
	case "steer":
		nodeId := ""
		if input.NodeId != nil {
			nodeId = strings.TrimSpace(*input.NodeId)
		}
		text := ""
		if input.Text != nil {
			text = strings.TrimSpace(*input.Text)
		}
		if nodeId == "" {
			Raise("invalid_input", "steer needs the node whose running turn receives the message")
		}
		if text == "" {
			Raise("invalid_input", "A nonempty steering message is required")
		}
		active := ActiveOperationForNode(runtime.store, target, nodeId)
		if active == nil {
			Raise("steering_unavailable", "Node "+nodeId+" has no running turn to steer")
		}
		steered := runtime.execution.Steer(active.Id, text)
		return runtime.store.Transaction(func() any {
			return map[string]any{
				"taskId":      target,
				"nodeId":      nodeId,
				"operationId": active.Id,
				"steered":     steered,
				"cursor":      runtime.store.Event(target, "operation.steered", map[string]any{"nodeId": nodeId, "operationId": active.Id, "actor": "agent", "text": text}),
			}
		})
	}
	Raise("invalid_input", "Unknown control action "+input.Action)
	return nil
}

// controlTarget names the task a control action may act on.
func (supervisor *TaskRuntimeSupervisor) controlTarget(requested *string) string {
	target := supervisor.taskId
	if requested != nil && strings.TrimSpace(*requested) != "" {
		target = strings.TrimSpace(*requested)
	}
	if target == supervisor.taskId {
		return target
	}
	conversation := runtime2Conversation(supervisor.runtime, supervisor.taskId)
	if conversation == nil || runtime2Conversation(supervisor.runtime, target) != conversation {
		Raise("invalid_input", "Control reaches only tasks of this conversation")
	}
	return target
}

// runtime2Conversation reads the conversation of one task.
func runtime2Conversation(runtime *TaskRuntime, taskId string) *string {
	conversation := runtime.store.Task(taskId).ConversationID
	return conversation
}

// TaskRuntimeProposeInput is one proposal of the main Agent.
type TaskRuntimeProposeInput struct {
	ProposalVersion int
	Summary         string
	Acceptance      []AcceptanceItem
	Decisions       []string
	HasDecisions    bool
	Definition      GraphDefinition
	RequestId       string
	NewVersion      bool
}

// Propose records one draft of the main Agent.
func (supervisor *TaskRuntimeSupervisor) Propose(input TaskRuntimeProposeInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	proposal := NativeProposal{
		RequirementVersion: input.ProposalVersion,
		Summary:            input.Summary,
		Acceptance:         input.Acceptance,
		Decisions:          input.Decisions,
		Definition:         input.Definition,
	}
	result := runtime.store.Command("supervisor:"+supervisor.taskId, input.RequestId, map[string]any{
		"type": "propose", "proposal": proposal, "newVersion": input.NewVersion,
	}, func() any {
		task := runtime.store.Task(supervisor.taskId)
		if task.AcceptedProposal != nil {
			Raise("requirements_locked", "This task already has a confirmed graph: revise the running graph with graph_patch instead of proposing a new draft")
		}
		if task.RequirementVersion != int64(input.ProposalVersion) {
			Raise("stale_requirement", "Proposal uses an old requirement version")
		}
		ValidateProposal(proposal)
		spec := CanonicalJSON(proposal)
		digest := ContentDigest(spec)
		conversation := ConversationForTask(runtime.store, supervisor.taskId)
		var current map[string]any
		if task.LatestProposal > 0 {
			current = kernelRow(runtime.store.Db, "SELECT version,requirement_version,draft_revision,archived_at,deleted_at FROM proposals WHERE task_id=? AND version=?", supervisor.taskId, task.LatestProposal)
		}
		confirmed := false
		if current != nil && conversation != nil {
			confirmed = kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?",
				conversation.Id, kernelInt(current["version"])) != nil
		}
		inPlace := current != nil && !input.NewVersion && !confirmed &&
			kernelInt(current["requirement_version"]) == int64(input.ProposalVersion) &&
			current["archived_at"] == nil && current["deleted_at"] == nil
		highWater := kernelInt(kernelRow(runtime.store.Db, "SELECT COALESCE(MAX(version),0) AS max FROM proposals WHERE task_id=?", supervisor.taskId)["max"])
		version := int(highWater) + 1
		if int(task.LatestProposal) > version {
			version = int(task.LatestProposal) + 1
		}
		draftRevision := 1
		if inPlace {
			version = int(kernelInt(current["version"]))
			draftRevision = int(kernelInt(current["draft_revision"])) + 1
		}
		var snapshot *string
		if input.HasDecisions {
			curated := []string{}
			for _, decision := range input.Decisions {
				trimmed := strings.TrimSpace(decision)
				if trimmed == "" {
					continue
				}
				curated = append(curated, trimmed)
			}
			lines := []string{}
			for _, decision := range curated {
				lines = append(lines, "- "+decision)
			}
			text := strings.Join(lines, "\n")
			snapshot = &text
		} else if conversation != nil {
			since := conversation.BindingSinceSeq
			rows := kernelRows(runtime.store.Db, "SELECT seq,text FROM messages WHERE conversation_id=? AND role='user' AND state='delivered' AND seq>? ORDER BY seq", conversation.Id, since)
			if len(rows) > DECISION_DIGEST_MAX_MESSAGES {
				head := rows[:DECISION_DIGEST_HEAD]
				tail := rows[len(rows)-DECISION_DIGEST_TAIL:]
				rows = append(append([]map[string]any{}, head...), tail...)
			}
			lines := []string{}
			for _, row := range rows {
				text := kernelString(row["text"])
				if !StatesADecision(text) {
					continue
				}
				trimmed := text
				if len([]rune(trimmed)) > 240 {
					trimmed = string([]rune(trimmed)[:240])
				}
				lines = append(lines, "- [msg "+itoa(int(kernelInt(row["seq"])))+"] "+trimmed)
			}
			for len(lines) > 1 && len(strings.Join(lines, "\n")) > DECISION_DIGEST_MAX_CHARS {
				index := (len(lines) - 1) / 2
				lines = append(lines[:index], lines[index+1:]...)
			}
			if len(lines) > 0 {
				text := strings.Join(lines, "\n")
				snapshot = &text
			}
		}
		if inPlace {
			kernelExec(runtime.store.Db, "UPDATE proposals SET requirement_version=?,spec=?,decision_snapshot=?,draft_revision=?,draft_digest=? WHERE task_id=? AND version=?",
				input.ProposalVersion, spec, snapshot, draftRevision, digest, supervisor.taskId, version)
		} else {
			kernelExec(runtime.store.Db, "INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot,draft_revision,draft_digest) VALUES(?,?,?,?,?,?,?)",
				supervisor.taskId, version, input.ProposalVersion, spec, snapshot, draftRevision, digest)
		}
		if task.LatestProposal != int64(version) {
			kernelExec(runtime.store.Db, "UPDATE tasks SET latest_proposal=? WHERE id=?", version, supervisor.taskId)
		}
		eventType := "proposal.created"
		if inPlace {
			eventType = "proposal.edited"
		}
		return map[string]any{
			"taskId":          supervisor.taskId,
			"proposalVersion": version,
			"draftRevision":   draftRevision,
			"cursor":          runtime.store.Event(supervisor.taskId, eventType, map[string]any{"proposalVersion": version, "draftRevision": draftRevision}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// TaskRuntimeWithdrawInput withdraws one draft of the main Agent.
type TaskRuntimeWithdrawInput struct {
	ProposalVersion int
	Reason          *string
	RequestId       string
}

// WithdrawDraft retires the current unconfirmed draft.
func (supervisor *TaskRuntimeSupervisor) WithdrawDraft(input TaskRuntimeWithdrawInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	result := runtime.store.Command("supervisor:"+supervisor.taskId, input.RequestId, map[string]any{"type": "withdraw", "proposalVersion": input.ProposalVersion}, func() any {
		task := runtime.store.Task(supervisor.taskId)
		row := kernelRow(runtime.store.Db, "SELECT version FROM proposals WHERE task_id=? AND version=?", supervisor.taskId, input.ProposalVersion)
		if row == nil {
			Raise("not_found", "That draft does not exist")
		}
		if task.LatestProposal != int64(input.ProposalVersion) {
			Raise("stale_proposal", "Only the current draft can be withdrawn")
		}
		if task.AcceptedProposal != nil {
			Raise("requirements_locked", "A confirmed draft cannot be withdrawn")
		}
		conversation := ConversationForTask(runtime.store, supervisor.taskId)
		if conversation != nil && kernelRow(runtime.store.Db, "SELECT proposal_version FROM conversation_acceptances WHERE conversation_id=? AND proposal_version=?",
			conversation.Id, input.ProposalVersion) != nil {
			Raise("already_accepted", "This draft was already confirmed")
		}
		next := input.ProposalVersion + 1
		kernelExec(runtime.store.Db, "UPDATE tasks SET latest_proposal=? WHERE id=?", next, supervisor.taskId)
		reason := ""
		if input.Reason != nil {
			reason = strings.TrimSpace(*input.Reason)
		}
		if conversation != nil {
			text := "草稿 v" + itoa(input.ProposalVersion) + " 已作废，请重新调查后生成新草稿。"
			if reason != "" {
				text = "草稿 v" + itoa(input.ProposalVersion) + " 已作废：" + reason + "。请重新调查后生成新草稿。"
			}
			AppendMessage(runtime.store, MessageInput{
				ConversationID: conversation.Id,
				Role:           MessageRoleSystem,
				Kind:           "project",
				State:          MessageStateDone,
				Text:           text,
			})
		}
		return map[string]any{
			"taskId":              supervisor.taskId,
			"withdrawnVersion":    input.ProposalVersion,
			"nextProposalVersion": next,
			"cursor":              runtime.store.Event(supervisor.taskId, "proposal.withdrawn", map[string]any{"proposalVersion": input.ProposalVersion, "reason": reason}),
		}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// ValidateProposal checks one draft against the current requirement.
func (supervisor *TaskRuntimeSupervisor) ValidateProposal(proposal NativeProposal) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	task := runtime.store.Task(supervisor.taskId)
	if task.RequirementVersion != int64(proposal.RequirementVersion) {
		Raise("stale_requirement", "Proposal uses an old requirement version")
	}
	ValidateProposal(proposal)
	return map[string]any{"valid": true, "requirementVersion": task.RequirementVersion}
}

// GraphState reads the graph projection the main Agent sees.
func (supervisor *TaskRuntimeSupervisor) GraphState() map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	task := runtime.store.Task(supervisor.taskId)
	view := runtime.User().Task(supervisor.taskId).View()
	native := KernelGraphView(runtime.kernel, supervisor.taskId)
	state := map[string]any{
		"taskId":                  supervisor.taskId,
		"conversationId":          task.ConversationID,
		"projectId":               task.ProjectID,
		"request":                 task.Request,
		"phase":                   task.Phase,
		"status":                  view["status"],
		"paused":                  view["paused"],
		"requirementVersion":      task.RequirementVersion,
		"proposalVersion":         task.LatestProposal,
		"acceptedProposalVersion": task.AcceptedProposal,
		"graphVersion":            view["graphVersion"],
		"targetBranch":            task.TargetBranch,
		"integrationSha":          task.IntegrationSha,
		"nodes":                   view["nodes"],
		"evidence":                view["evidence"],
		"questions":               view["questions"],
		"worktrees":               view["worktrees"],
		"cost":                    view["cost"],
	}
	if native != nil {
		state["graph"] = native
		state["modules"] = native
	}
	return state
}

// TaskRuntimeTaskStatusInput is one status query of the main Agent.
type TaskRuntimeTaskStatusInput struct {
	TaskId      *string
	NodeId      *string
	WaitForNode *string
	TimeoutMs   *int
}

// TaskStatus reads the compact status projection of one task.
func (supervisor *TaskRuntimeSupervisor) TaskStatus(input TaskRuntimeTaskStatusInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	owned := kernelRow(runtime.store.Db, "SELECT owner_task_id FROM kernel_graph_owners WHERE task_id=?", *input.TaskId)
	target := supervisor.taskId
	if input.TaskId != nil {
		if owned != nil && kernelString(owned["owner_task_id"]) == supervisor.taskId {
			target = *input.TaskId
		} else {
			target = taskRuntimeConversationTarget(runtime.store, supervisor.taskId, input.TaskId, "A status query")
		}
	}
	view := taskRuntimeStatusView(runtime.store, runtime.kernel, target, input.NodeId)
	if input.WaitForNode == nil {
		return view
	}
	timeout := 120_000
	if input.TimeoutMs != nil {
		timeout = *input.TimeoutMs
	}
	if timeout < 0 {
		timeout = 0
	}
	if timeout > 600_000 {
		timeout = 600_000
	}
	started := NowMillis()
	known := map[string]bool{}
	for _, entry := range view["questions"].([]map[string]any) {
		known[entry["id"].(string)] = true
	}
	for _, entry := range view["problems"].([]map[string]any) {
		known[entry["id"].(string)] = true
	}
	current := view
	reason := "timeout"
	for {
		found := false
		for _, node := range current["nodes"].([]map[string]any) {
			if node["id"] == *input.WaitForNode {
				found = true
			}
		}
		if !found {
			taskRuntimeMissingTaskNode(runtime.kernel, target, *input.WaitForNode)
		}
		changed := false
		for _, entry := range current["questions"].([]map[string]any) {
			if !known[entry["id"].(string)] {
				changed = true
			}
		}
		for _, entry := range current["problems"].([]map[string]any) {
			if !known[entry["id"].(string)] {
				changed = true
			}
		}
		if changed {
			reason = "needs_you"
			break
		}
		settled := true
		for _, node := range current["nodes"].([]map[string]any) {
			if node["id"] != *input.WaitForNode {
				continue
			}
			status, _ := node["status"].(string)
			if status == "pending" || status == "running" {
				settled = false
			}
		}
		if runtime.kernel.LatestRevision(target) != nil {
			queued := kernelRow(runtime.store.Db, "SELECT 1 FROM kernel_queue WHERE task_id=? AND node_id=? AND state IN ('queued','claimed') LIMIT 1", target, *input.WaitForNode)
			if queued != nil {
				settled = false
			}
		}
		if settled {
			reason = "settled"
			break
		}
		if NowMillis()-started >= int64(timeout) {
			reason = "timeout"
			break
		}
		time.Sleep(time.Second)
		current = taskRuntimeStatusView(runtime.store, runtime.kernel, target, input.NodeId)
	}
	current["waitedMs"] = NowMillis() - started
	current["reason"] = reason
	return current
}

// ListProblems reads the main-owned problems of one conversation.
func (supervisor *TaskRuntimeSupervisor) ListProblems() []map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		return []map[string]any{}
	}
	tasks := runtime.conversationTaskIds(conversation.Id)
	if len(tasks) == 0 {
		return []map[string]any{}
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tasks)), ",")
	params := []any{}
	for _, id := range tasks {
		params = append(params, id)
	}
	rows := kernelRows(runtime.store.Db, `SELECT q.id,q.task_id,q.node_id,q.kind,q.data,
      t.request,t.phase,n.status AS node_status,i.model
    FROM questions q JOIN tasks t ON t.id=q.task_id
    LEFT JOIN nodes n ON n.task_id=q.task_id AND n.id=q.node_id
    LEFT JOIN instances i ON i.id=n.instance_id
    WHERE q.owner='main' AND q.status='open' AND q.task_id IN (`+placeholders+`)
    ORDER BY q.rowid`, params...)
	out := []map[string]any{}
	for _, row := range rows {
		var data any
		if err := json.Unmarshal([]byte(kernelString(row["data"])), &data); err != nil {
			panic(err)
		}
		out = append(out, map[string]any{
			"id":             kernelString(row["id"]),
			"taskId":         kernelString(row["task_id"]),
			"nodeId":         kernelString(row["node_id"]),
			"kind":           kernelString(row["kind"]),
			"summary":        QuestionSummary(kernelString(row["kind"]), data),
			"data":           data,
			"taskRequest":    kernelString(row["request"]),
			"taskPhase":      kernelString(row["phase"]),
			"nodeStatus":     row["node_status"],
			"model":          row["model"],
			"allowedActions": ProblemActions(kernelString(row["kind"])),
		})
	}
	return out
}

// TaskRuntimeResolveInput resolves one main-owned problem.
type TaskRuntimeResolveInput struct {
	QuestionId string
	Action     string
	Response   *string
	Proof      *string
	RequestId  string
}

// ResolveProblem answers one main-owned problem.
func (supervisor *TaskRuntimeSupervisor) ResolveProblem(input TaskRuntimeResolveInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This master is not attached to a conversation")
	}
	tasks := runtime.conversationTaskIds(conversation.Id)
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(tasks)), ",")
	params := []any{}
	for _, id := range tasks {
		params = append(params, id)
	}
	params = append(params, input.QuestionId)
	for _, id := range tasks {
		params = append(params, id)
	}
	receipt := runtime.store.Command("problems:"+supervisor.taskId, input.RequestId, input, func() any {
		row := kernelRow(runtime.store.Db, `SELECT id,task_id,node_id,kind,data
          FROM questions WHERE id=? AND owner='main' AND status='open' AND task_id IN (`+placeholders+`)`, params...)
		if row == nil {
			settledParams := []any{input.QuestionId}
			for _, id := range tasks {
				settledParams = append(settledParams, id)
			}
			settled := kernelRow(runtime.store.Db, `SELECT id,task_id,answer FROM questions
          WHERE id=? AND owner='main' AND status='resolved' AND task_id IN (`+placeholders+`)`, settledParams...)
			if settled == nil {
				Raise("not_found", "No open main-Agent problem with that id")
			}
			return map[string]any{
				"questionId":      kernelString(settled["id"]),
				"taskId":          kernelString(settled["task_id"]),
				"action":          input.Action,
				"resolved":        true,
				"alreadyResolved": true,
				"answer":          settled["answer"],
			}
		}
		allowed := []string{}
		for _, action := range ProblemActions(kernelString(row["kind"])) {
			allowed = append(allowed, string(action))
		}
		if !containsString(allowed, input.Action) {
			Raise("invalid_answer", "Problem "+kernelString(row["kind"])+" does not accept "+input.Action)
		}
		if input.Action == "escalate" {
			if input.Response == nil || strings.TrimSpace(*input.Response) == "" {
				Raise("invalid_answer", "An explanation is required to escalate a problem to the user")
			}
			text := strings.TrimSpace(*input.Response)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			runtime.execution.Escalate(kernelString(row["task_id"]), kernelString(row["id"]), text)
			return map[string]any{"questionId": kernelString(row["id"]), "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": true}
		}
		answer := Answer{}
		switch input.Action {
		case "retry":
			answer = Answer{Type: "retry"}
		case "acknowledge":
			answer = Answer{Type: "acknowledge"}
		case "respond":
			if input.Response == nil || strings.TrimSpace(*input.Response) == "" {
				Raise("invalid_answer", "A response is required")
			}
			text := strings.TrimSpace(*input.Response)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			answer = Answer{Type: "respond", Value: text}
		default:
			if input.Proof == nil || strings.TrimSpace(*input.Proof) == "" {
				Raise("invalid_answer", "A reconciliation rationale is required")
			}
			text := strings.TrimSpace(*input.Proof)
			if len([]rune(text)) > 4000 {
				text = string([]rune(text)[:4000])
			}
			answer = Answer{Type: "reconcile_usage", Proof: text}
		}
		runtime.execution.Answer(kernelString(row["task_id"]), kernelString(row["id"]), answer)
		runtime.store.Event(kernelString(row["task_id"]), "problem.resolved", map[string]any{
			"questionId": kernelString(row["id"]),
			"nodeId":     kernelString(row["node_id"]),
			"kind":       kernelString(row["kind"]),
			"action":     input.Action,
		})
		return map[string]any{"questionId": kernelString(row["id"]), "taskId": kernelString(row["task_id"]), "action": input.Action, "resolved": true}
	})
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	record, _ := jsonRecord(receipt)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// PendingHumanChecks reads the open human acceptance checks of one conversation.
func (supervisor *TaskRuntimeSupervisor) PendingHumanChecks() []any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		return []any{}
	}
	out := []any{}
	for _, check := range PendingHumanChecks(runtime.store, conversation.Id) {
		out = append(out, check)
	}
	return out
}

// TaskRuntimeReviewInput reviews one human acceptance check.
type TaskRuntimeReviewInput struct {
	QuestionId string
	Approve    bool
	Note       string
	RequestId  string
}

// ReviewHumanCheck approves or sends back one human acceptance check.
func (supervisor *TaskRuntimeSupervisor) ReviewHumanCheck(input TaskRuntimeReviewInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This master is not attached to a conversation")
	}
	inConversation := false
	for _, check := range PendingHumanChecks(runtime.store, conversation.Id) {
		record, _ := jsonRecord(check)
		if record != nil && record["questionId"] == input.QuestionId {
			inConversation = true
		}
	}
	if !inConversation {
		Raise("not_found", "No open human acceptance check with that id in this conversation")
	}
	result := runtime.store.Command("human-review:"+supervisor.taskId, input.RequestId, input, func() any {
		if input.Approve {
			return map[string]any{"questionId": input.QuestionId, "approved": ApproveHumanCheck(runtime.store, input.QuestionId, input.Note)}
		}
		check := HumanCheckPreReview(runtime.store, input.QuestionId)
		record, _ := jsonRecord(check)
		if record == nil || record["status"] != "open" {
			Raise("not_found", "That human acceptance check is not open")
		}
		taskId, _ := record["taskId"].(string)
		nodeId, _ := record["nodeId"].(string)
		InsertQuestion(runtime.store, QuestionInput{
			TaskId: taskId,
			NodeId: nodeId,
			Kind:   "rework",
			Data: map[string]any{
				"prompt":   "The main Agent reviewed the human acceptance check and sent it back",
				"reason":   input.Note,
				"rejected": true,
			},
		})
		kernelExec(runtime.store.Db, "UPDATE questions SET status='resolved',answer=? WHERE id=?",
			CanonicalJSON(map[string]any{"type": "reject", "reason": input.Note}), input.QuestionId)
		return map[string]any{"questionId": input.QuestionId, "approved": false, "sentBack": true}
	})
	record, _ := jsonRecord(result)
	if record == nil {
		return map[string]any{}
	}
	return record
}

// ListProjects reads the projects of the runtime.
func (supervisor *TaskRuntimeSupervisor) ListProjects() []map[string]any {
	return supervisor.runtime.User().Projects()
}

// BindProject binds the conversation of the supervisor to a project.
func (supervisor *TaskRuntimeSupervisor) BindProject(projectId, requestId string) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := ConversationForTask(runtime.store, supervisor.taskId)
	if conversation == nil {
		Raise("not_found", "This Main Agent is not attached to a conversation")
	}
	return runtime.Conversations().Bind(conversation.Id, projectId, requestId)
}

// ConfirmDraft confirms one draft on behalf of the user.
func (supervisor *TaskRuntimeSupervisor) ConfirmDraft(input TaskRuntimeConfirmInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	if strings.TrimSpace(input.AttestationInstruction()) == "" {
		Raise("invalid_input", "An instruction is required: record the words that authorised this confirmation")
	}
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to confirm")
	}
	return runtime.Conversations().Confirm(*conversation, input)
}

// AttestationInstruction reads the recorded instruction of a confirmation.
func (input TaskRuntimeConfirmInput) AttestationInstruction() string {
	if input.Attestation == nil {
		return ""
	}
	return input.Attestation.Instruction
}

// ArchiveDraft archives one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) ArchiveDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to archive a draft in")
	}
	return runtime.Conversations().ArchiveDraft(*conversation, input)
}

// RestoreDraft restores one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) RestoreDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to restore a draft in")
	}
	return runtime.Conversations().RestoreDraft(*conversation, input)
}

// DeleteDraft deletes one draft of the conversation of the supervisor.
func (supervisor *TaskRuntimeSupervisor) DeleteDraft(input TaskRuntimeDraftInput) map[string]any {
	runtime := supervisor.runtime
	runtime.ensureOpen()
	conversation := runtime.store.Task(supervisor.taskId).ConversationID
	if conversation == nil {
		Raise("invalid_input", "This task has no conversation to delete a draft from")
	}
	return runtime.Conversations().DeleteDraft(*conversation, input)
}

// RunReady dispatches every currently ready node.
func (runtime *TaskRuntime) RunReady() ExecutionDispatch {
	runtime.ensureOpen()
	return runtime.execution.RunReady()
}

// Drive dispatches newly ready work as completions land.
func (runtime *TaskRuntime) Drive() ExecutionDispatch {
	runtime.ensureOpen()
	return runtime.execution.Drive()
}

// Report settles one operation with the result a worker produced.
func (runtime *TaskRuntime) Report(id string, generation int, result OperationResult) {
	runtime.ensureOpen()
	runtime.execution.Report(id, generation, result)
}

// Reconcile resolves one unknown external outcome.
func (runtime *TaskRuntime) Reconcile(id string) {
	runtime.ensureOpen()
	runtime.execution.Reconcile(id)
}

// CheckProjects refuses a hot configuration that moves the root of a project in flight.
func (runtime *TaskRuntime) CheckProjects(projects []ProjectConfig) {
	runtime.ensureOpen()
	for _, project := range projects {
		if strings.TrimSpace(project.Id) == "" || strings.TrimSpace(project.Root) == "" {
			Raise("invalid_input", "Project identity and root must be nonempty strings")
		}
		root, err := filepath.Abs(project.Root)
		if err != nil {
			root = project.Root
		}
		previous := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", project.Id)
		if previous == nil || kernelString(previous["root"]) == root {
			continue
		}
		active := kernelInt(kernelRow(runtime.store.Db, "SELECT COUNT(*) AS count FROM tasks WHERE project_id=? AND phase IN ('discussing','running','queued')", project.Id)["count"])
		if active > 0 {
			Raise("project_conflict", "Project "+project.Id+" has tasks in flight; its root cannot change until they finish")
		}
	}
}

// SyncProjects registers hot-added projects and rejects root moves in flight.
func (runtime *TaskRuntime) SyncProjects() {
	runtime.ensureOpen()
	configured := runtime.configuredProjects()
	runtime.CheckProjects(configured)
	runtime.store.Transaction(func() any {
		for _, project := range configured {
			root, err := filepath.Abs(project.Root)
			if err != nil {
				root = project.Root
			}
			grants := taskRuntimeGrants(project.Grants)
			previous := kernelRow(runtime.store.Db, "SELECT root FROM projects WHERE id=?", project.Id)
			if previous == nil {
				kernelExec(runtime.store.Db, "INSERT INTO projects VALUES(?,?,?)", project.Id, root, grants)
				continue
			}
			if kernelString(previous["root"]) != root {
				kernelExec(runtime.store.Db, "UPDATE projects SET root=? WHERE id=?", root, project.Id)
			}
		}
		return nil
	})
}

// RecoverMasters creates master nodes for pending tasks after a hot configuration apply.
func (runtime *TaskRuntime) RecoverMasters() int {
	runtime.ensureOpen()
	if runtime.master == nil || runtime.masterModel() == nil || runtime.masterDefinitionVersion() == nil {
		return 0
	}
	created := 0
	runtime.store.Transaction(func() any {
		pending := kernelRows(runtime.store.Db, "SELECT id, project_id, phase FROM tasks WHERE phase IN ('discussing','chatting') ORDER BY created_seq")
		for _, task := range pending {
			phase := kernelString(task["phase"])
			projectId := kernelString(task["project_id"])
			if phase != "chatting" && !runtime.allowedProjects()[projectId] {
				continue
			}
			nodes := kernelRows(runtime.store.Db, "SELECT spec FROM nodes WHERE task_id=?", kernelString(task["id"]))
			hasMaster := false
			for _, node := range nodes {
				var spec NodeSpec
				if err := json.Unmarshal([]byte(kernelString(node["spec"])), &spec); err == nil {
					if spec.Role != nil && *spec.Role == "master" {
						hasMaster = true
					}
				}
			}
			if hasMaster {
				continue
			}
			runtime.createMasterNode(kernelString(task["id"]))
			runtime.store.Event(kernelString(task["id"]), "task.master_recovered", map[string]any{"reason": "dispatch was disabled when the task was created"})
			created++
		}
		return nil
	})
	return created
}

// AckRsiRestart acknowledges one pending RSI reload.
func (runtime *TaskRuntime) AckRsiRestart(id string) any {
	runtime.ensureOpen()
	if runtime.rsi == nil {
		Raise("rsi_unavailable", "RSI is unavailable")
	}
	result := runtime.rsi.AckRestart(id, runtime.store)
	record, _ := jsonRecord(result)
	if record != nil {
		if cleared, ok := record["cleared"].(bool); ok && cleared && runtime.autoWake {
			runtime.execution.Kick()
		}
	}
	return result
}

// TaskRuntimeProjectPrepareInput prepares one project for work.
type TaskRuntimeProjectPrepareInput struct {
	ProjectId      string
	RequestId      string
	Initialize     bool
	CreateBaseline bool
}

// Prepare authorizes the Git preparation of one project.
func (runtime *TaskRuntime) Prepare(input TaskRuntimeProjectPrepareInput) any {
	runtime.ensureOpen()
	if !runtime.allowedProjects()[input.ProjectId] {
		Raise("invalid_input", "The project is no longer part of the current configuration")
	}
	payload := map[string]any{
		"type": "prepare", "projectId": input.ProjectId, "initialize": input.Initialize, "createBaseline": input.CreateBaseline,
	}
	encoded := CanonicalJSON(payload)
	previous := kernelRow(runtime.store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", "projects", input.RequestId)
	if previous != nil {
		if kernelString(previous["payload"]) != encoded {
			Raise("idempotency_conflict", "requestId was already used with different content")
		}
		return parseJSON(kernelString(previous["receipt"]))
	}
	opId := graphUUID()
	headBefore := runtime.git.ProjectHead(input.ProjectId)
	fingerprintBefore := runtime.git.ProjectFingerprint(input.ProjectId)
	runtime.store.Transaction(func() any {
		kernelExec(runtime.store.Db, "INSERT INTO git_ops VALUES(?,?,?,?,?,?)", opId, "project:"+input.ProjectId, "prepare", "intent",
			CanonicalJSON(map[string]any{"payload": payload, "requestId": input.RequestId, "headBefore": headBefore, "fingerprintBefore": fingerprintBefore}), nil)
		return nil
	})
	prep := runtime.git.PrepareProject(input.ProjectId, input.Initialize, input.CreateBaseline)
	if prep == nil {
		Raise("invalid_graph", "The project could not be prepared")
	}
	return runtime.settlePrepare(opId, input.RequestId, payload, prep, map[string]any{"state": prep.State, "baselineSha": prep.BaselineSha})
}

// settlePrepare persists the settled prepare receipt idempotently.
func (runtime *TaskRuntime) settlePrepare(opId, requestId string, payload map[string]any, prep *ProjectPreparation, result map[string]any) any {
	encoded := CanonicalJSON(payload)
	return runtime.store.Transaction(func() any {
		kernelExec(runtime.store.Db, "UPDATE git_ops SET state=?, result=? WHERE id=?", "succeeded", CanonicalJSON(result), opId)
		duplicate := kernelRow(runtime.store.Db, "SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?", "projects", requestId)
		if duplicate != nil {
			if kernelString(duplicate["payload"]) != encoded {
				Raise("idempotency_conflict", "requestId was already used with different content")
			}
			return parseJSON(kernelString(duplicate["receipt"]))
		}
		receipt := map[string]any{
			"state":       prep.State,
			"baselineSha": prep.BaselineSha,
			"cursor":      runtime.store.Event(nil, "project.prepared", map[string]any{"projectId": payload["projectId"], "state": prep.State, "baselineSha": prep.BaselineSha}),
		}
		kernelExec(runtime.store.Db, "INSERT INTO commands VALUES(?,?,?,?)", "projects", requestId, encoded, CanonicalJSON(receipt))
		return receipt
	})
}

// Preparation reads the recorded preparation of one project.
func (runtime *TaskRuntime) Preparation(projectId string) *ProjectPreparation {
	runtime.ensureOpen()
	prep := runtime.git.Preparation(projectId)
	if prep == nil {
		Raise("not_found", "No preparation recorded for "+projectId)
	}
	return prep
}

// Artifacts reads the artifact workspace of the runtime.
func (runtime *TaskRuntime) Artifacts() *ArtifactWorkspace {
	return runtime.artifacts
}

// ListConversationArtifacts lists the artifacts of every task of one conversation.
//
// Every task in the conversation sees the same project-scoped artifacts, so the union
// has to be deduplicated by artifact and version or a shared artifact would be listed
// once per task.
func (runtime *TaskRuntime) ListConversationArtifacts(conversationId string, query ArtifactQuery) ArtifactPage {
	seen := map[string]ArtifactRecord{}
	for _, taskId := range runtime.conversationTaskIds(conversationId) {
		scoped := query
		scoped.TaskId = taskId
		limit := 200
		scoped.Limit = &limit
		for _, record := range runtime.artifacts.List(scoped).Artifacts {
			seen[record.ArtifactId+"@"+itoa(record.Version)] = record
		}
	}
	records := make([]ArtifactRecord, 0, len(seen))
	for _, record := range seen {
		records = append(records, record)
	}
	sort.Slice(records, func(left, right int) bool { return records[left].CreatedAt > records[right].CreatedAt })
	limit := 100
	if query.Limit != nil {
		limit = *query.Limit
	}
	if limit < 1 {
		limit = 1
	}
	if limit > 200 {
		limit = 200
	}
	if limit > len(records) {
		limit = len(records)
	}
	return ArtifactPage{Artifacts: records[:limit], NextCursor: nil, Total: len(records)}
}

// Catalog reads the capability catalog of the runtime.
func (runtime *TaskRuntime) Catalog() *Catalog {
	return runtime.catalog
}

// Talent is the definition detail plus the per-metric experience statistics from the
// ledger.
func (runtime *TaskRuntime) Talent(id string, version *int, allVersions bool) any {
	runtime.ensureOpen()
	return map[string]any{
		"detail": TalentDetail(runtime.store, id, version, func(capabilityId, capabilityVersion string) *CapabilityRecord {
			return runtime.catalog.Capability(capabilityId, capabilityVersion)
		}),
		"experience": TalentExperienceOf(runtime.store, id, version, allVersions),
	}
}

// ControlGraph applies one graph control action.
func (runtime *TaskRuntime) ControlGraph(taskId string, input GraphControlInput) any {
	runtime.ensureOpen()
	payload := map[string]any{"graphId": taskId, "action": input.Action}
	if input.NodeId != nil {
		payload["nodeId"] = *input.NodeId
	}
	if input.ModuleId != nil {
		payload["moduleId"] = *input.ModuleId
	}
	if input.Seq != nil {
		payload["seq"] = *input.Seq
	}
	result := runtime.graphManagement(taskId).GraphControl(payload)
	if runtime.autoWake {
		runtime.execution.Kick()
	}
	return result
}

// PiExtensionUpdates lists the Pi extension sources that have a newer version than the
// one on disk.
//
// A source that cannot be inspected is reported with its error, never dropped: "we could
// not look" and "the extension is current" are different facts.
func (runtime *TaskRuntime) PiExtensionUpdates() any {
	runtime.ensureOpen()
	updates := []PiExtensionUpdate{}
	for _, record := range runtime.catalog.Capabilities() {
		if record.Kind != "pi-extension" || record.Status != "available" || record.PackageSource == nil {
			continue
		}
		source := *record.PackageSource
		update := PiExtensionUpdate{Id: record.Id, Version: record.Version, Source: source}
		status, err := ResolvePiExtensionSourceStatus(PiExtensionSourceInput{
			Source: source, Cwd: runtime.stateDir, AgentDir: PiExtensionCacheDir(runtime.catalog),
		})
		if err != nil {
			message := err.Error()
			update.Error = &message
			update.Installed = nil
			update.Latest = nil
			update.Available = false
			update.InstallGaps = []string{}
			updates = append(updates, update)
			continue
		}
		update.PiExtensionSourceStatus = status
		updates = append(updates, update)
	}
	return map[string]any{"updates": updates}
}

// UpdatePiExtension installs or upgrades one Pi extension source, then rescans the
// capability library.
func (runtime *TaskRuntime) UpdatePiExtension(id string, version string) any {
	runtime.ensureOpen()
	record := runtime.catalog.Capability(id, version)
	if record == nil || record.PackageSource == nil || *record.PackageSource == "" {
		Raise("not_found", "Pi extension "+id+"@"+version+" has no package source")
	}
	result, err := UpdatePiExtensionSource(PiExtensionSourceInput{
		Source: *record.PackageSource, Cwd: runtime.stateDir, AgentDir: PiExtensionCacheDir(runtime.catalog),
	})
	if err != nil {
		panic(err)
	}
	SyncCapabilityVersion(record.Source, result.Version)
	runtime.catalog.Refresh()
	return result
}

// AgentContextPreview is the prompt library view of the next main Agent turn.
//
// The master follows the latest definition of its own recipe on the next turn, so the
// preview has to describe that same version instead of the one the instance last ran.
func (runtime *TaskRuntime) AgentContextPreview(conversationId *string) any {
	runtime.ensureOpen()
	library := runtime.agentContextLibrary()
	if library == nil {
		Raise("invalid_config", "Agent context library is unavailable")
	}
	var view map[string]any
	if conversationId != nil && *conversationId != "" {
		limit := float64(1)
		view = runtime.Conversations().View(*conversationId, NodeEntryQuery{Limit: &limit})
	}
	definitions := runtime.catalog.ListDefinitions()
	latestDefinitionVersion := ""
	if runtime.master != nil && runtime.master.DefinitionVersion != nil {
		latestDefinitionVersion = runtime.master.DefinitionVersion()
	}
	if latestDefinitionVersion == "" {
		for _, item := range definitions {
			if item.Id == "main" {
				latestDefinitionVersion = "main@" + itoa(int(item.Version))
				break
			}
		}
	}
	if latestDefinitionVersion == "" {
		for _, item := range definitions {
			if item.Id == "master" {
				latestDefinitionVersion = "master@" + itoa(int(item.Version))
				break
			}
		}
	}
	masterVersion := ""
	masterId := ""
	if master, ok := view["master"].(map[string]any); ok && master != nil {
		masterVersion, _ = master["definitionVersion"].(string)
	}
	if masterVersion != "" {
		masterId = strings.Split(masterVersion, "@")[0]
	}
	definitionVersion := masterVersion
	if masterId != "" {
		for _, item := range definitions {
			if item.Id == masterId {
				definitionVersion = masterId + "@" + itoa(int(item.Version))
				break
			}
		}
	}
	if definitionVersion == "" {
		definitionVersion = latestDefinitionVersion
	}
	definitionId := ""
	if definitionVersion != "" {
		definitionId = strings.Split(definitionVersion, "@")[0]
	}
	action := "master"
	if runtime.master != nil && runtime.master.Action != "" {
		action = runtime.master.Action
	}
	projectRoot := ""
	if view != nil {
		projectRoot, _ = view["projectRoot"].(string)
	}
	workspace := projectRoot
	if view != nil {
		master, _ := view["master"].(map[string]any)
		anchor, _ := view["anchorTaskId"].(string)
		if master != nil && anchor != "" {
			nodeId, _ := master["nodeId"].(string)
			if resolved := runtime.AgentWorkspace(anchor, nodeId); resolved != nil && *resolved != "" {
				workspace = *resolved
			}
		}
	}
	fullAccess := IsFullAccess(runtime.CurrentAccessPolicy())
	rsiAvailable := false
	if runtime.rsi != nil {
		rsiAvailable = runtime.rsi.Status(false).Available
	}
	assemblyInput := AgentContextAssemblyOptions{
		CapabilityBundleOptions: CapabilityBundleOptions{
			Catalog: runtime.catalog, DefinitionVersion: definitionVersion,
			SkillProjectRoot: projectRoot,
		},
		Action: action, Role: "master", Runtime: "node", Workspace: workspace,
		Library: library, FullAccess: fullAccess, Retrieval: true,
		Rsi: rsiAvailable && fullAccess,
	}
	if runtime.catalogOpt != nil {
		if prompt, ok := runtime.catalogOpt.BootstrapPrompts[definitionId]; ok && prompt != "" {
			assemblyInput.Bootstrap = &CapabilityBootstrap{Agent: prompt}
		}
		if runtime.catalogOpt.BootstrapToolPrompt != "" {
			if assemblyInput.Bootstrap == nil {
				assemblyInput.Bootstrap = &CapabilityBootstrap{}
			}
			assemblyInput.Bootstrap.Tool = runtime.catalogOpt.BootstrapToolPrompt
		}
	}
	capabilityRoot := runtime.catalog.CapabilityRootPath()
	if definitionId != "" && capabilityRoot != "" {
		assemblyInput.SkillFolder = AgentSkillsDir(definitionId, filepath.Dir(capabilityRoot))
		assemblyInput.SkillOwnedRoots = AgentSkillOwnedRoots(capabilityRoot, runtime.stateDir)
	}
	assembly := OpenAgentContextAssembly(assemblyInput)
	features := AgentToolFeatures{
		Role: "master", Run: true, Fetch: true, Catalog: true, GraphManagement: true,
		Conversations: &AgentConversationFeatures{Read: true, Write: true},
		Peers:         false,
		Artifacts:     agentArtifactAccessForPreview(action),
		Supervisor: &AgentSupervisorFeatures{
			ValidateProposal: true, GraphState: true, TaskStatus: true, ListProjects: true,
			BindProject: true, ListProblems: true, ResolveProblem: true, WithdrawDraft: true,
			ConfirmDraft: true, ArchiveDraft: true, RestoreDraft: true, DeleteDraft: true,
			PendingHumanChecks: true, ReviewHumanCheck: true, ControlTask: true,
		},
	}
	if runtime.systemCtx != nil {
		features.SystemContext = &AgentSystemFeatures{
			SystemSummary:     runtime.systemCtx.SystemSummary != nil,
			SystemDiagnostics: view != nil, ProposeSystemChange: view != nil, ApplySystemChange: view != nil,
		}
	}
	if runtime.rsi != nil {
		features.Rsi = &AgentRsiFeatures{Status: fullAccess, Apply: rsiAvailable && fullAccess}
	}
	preview := assembly.Preview(features)
	libraryView := library.View(map[string]string{
		"models": "{{models}}", "requirementVersion": "{{requirementVersion}}",
		"fullAccessInstruction": "{{fullAccessInstruction}}", "retrievalNote": "{{retrievalNote}}",
	})
	answer := map[string]any{
		"root": libraryView.Root, "prompts": libraryView.Prompts,
		"disabledTools":     assembly.DisabledTools,
		"docsRoot":          preview.DocsRoot,
		"definitionVersion": definitionVersion, "latestDefinitionVersion": latestDefinitionVersion,
		"tools": preview.Tools, "capabilities": preview.Capabilities,
		"sent": nil,
	}
	if view != nil {
		if anchor, _ := view["anchorTaskId"].(string); anchor != "" {
			if record := runtime.store.ConversationSystemPrompt(anchor); record != nil {
				tools := any(nil)
				if record.Tools.Valid {
					tools = record.Tools.String
				}
				answer["sent"] = map[string]any{
					"operationId": record.OperationID, "at": record.At,
					"text": record.Text, "tools": tools,
				}
			}
		}
	}
	return answer
}

// agentArtifactAccessForPreview is the artifact surface the main Agent preview shows.
func agentArtifactAccessForPreview(action string) *AgentArtifactAccess {
	access := AgentArtifactAccessFor(struct {
		Role   string
		Action string
	}{Role: "master", Action: action})
	return &access
}
