package graph

import (
	"database/sql"
	"encoding/json"
	"strings"
)

// TokenBudget is the frozen quota of one node execution.
type TokenBudget struct {
	Budget    float64 `json:"budget"`
	Unlimited bool    `json:"unlimited"`
}

// RevisionRow is one immutable graph definition.
type RevisionRow struct {
	TaskId     string
	Version    int
	Definition GraphDefinition
	Reason     string
	CreatedAt  int64
}

// DeliveryRow is one accepted value landing.
type DeliveryRow struct {
	Id              string  `json:"id"`
	TaskId          string  `json:"taskId"`
	SubmissionId    *string `json:"submissionId"`
	EdgeId          *string `json:"edgeId"`
	FromEndpoint    string  `json:"fromEndpoint"`
	ToEndpoint      string  `json:"toEndpoint"`
	Value           any     `json:"value"`
	Protocol        string  `json:"protocol"`
	RevisionVersion int     `json:"revisionVersion"`
	Seq             int64   `json:"seq"`
	State           string  `json:"state"`
	Source          string  `json:"source"`
	CreatedAt       int64   `json:"createdAt"`
}

// ExecutionRow is one node attempt.
type ExecutionRow struct {
	Id              string
	TaskId          string
	NodeId          string
	RevisionVersion int
	Attempt         int
	RetriesUsed     int
	ResubmitsUsed   int
	PendingGap      []string
	TokenBudget     *TokenBudget
	State           string
	SubmissionId    *string
	MissingRequired bool
	StartedAt       int64
	EndedAt         *int64
}

// SubmitOutput is one named output in a submission.
type SubmitOutput struct {
	Enable bool `json:"enable"`
	Value  any  `json:"value,omitempty"`
}

// SubmitRequest is one execution's output set.
type SubmitRequest struct {
	Outputs      map[string]SubmitOutput
	SubmissionId string
}

// SubmitReceipt is the durable result of submit.
type SubmitReceipt struct {
	SubmissionId string
	Replayed     bool
	Deliveries   []DeliveryRow
	NoRecipients bool
}

// QueueRow is one serial node input.
type QueueRow struct {
	Seq        int64   `json:"seq"`
	TaskId     string  `json:"taskId"`
	NodeId     string  `json:"nodeId"`
	Kind       string  `json:"kind"`
	Payload    any     `json:"payload"`
	Generation int64   `json:"generation"`
	Reason     *string `json:"reason"`
	State      string  `json:"state"`
	CreatedAt  int64   `json:"createdAt"`
}

// NodeStateRow is the per-node retry and pause counters.
type NodeStateRow struct {
	Attempts         int
	ResubmitsUsed    int
	RetriesAllowed   *int
	ResubmitsAllowed *int
	Paused           bool
	Rebinds          int
}

// DirectDelivery is a main-agent input and its landing.
type DirectDelivery struct {
	Delivery DeliveryRow
	Queue    *QueueRow
}

// AdmitNodeInput records the instance a node is admitted with.
type AdmitNodeInput struct {
	InstanceId string
	InstanceID string
	Kind       string
}

// AdmitModuleInput records a module's type and trigger.
type AdmitModuleInput struct {
	ModuleType string
	Trigger    string
}

// StartExecutionRequest opens or resumes one execution.
type StartExecutionRequest struct {
	ExecutionId     string
	NodeId          string
	RevisionVersion int
	TokenBudget     *TokenBudget
}

// QueueInsert is one queue append.
type QueueInsert = struct {
	NodeId  string
	Kind    string
	Payload any
}

// KernelNodeView is one admitted node.
type KernelNodeView struct {
	NodeId          string `json:"nodeId"`
	InstanceId      string `json:"instanceId"`
	Kind            string `json:"kind"`
	Status          string `json:"status"`
	RevisionVersion int    `json:"revisionVersion"`
}

// NodeBudgetState is the spent and held tokens of one node.
type NodeBudgetState struct {
	Budget    float64
	Unlimited bool
	Used      float64
	Reserved  float64
}

// KernelProviderCall is one actual provider send.
type KernelProviderCall struct {
	Id          string
	NodeId      string
	ExecutionId string
	Reserved    int64
	State       string
	Usage       *TokenUsage
	Model       *providerCallModel
	Purpose     string
	Cost        any
	CreatedAt   int64
	SettledAt   *int64
}

// ModuleInputRow is the latest value of one module input.
type ModuleInputRow struct {
	ModuleId  string
	Name      string
	Delivered bool
	Value     any
	Source    *string
	UpdatedAt int64
}

// ModuleTransitionInput is one module judgment.
type ModuleTransitionInput struct {
	ModuleId    string
	InputName   string
	InputValue  any
	StateBefore any
	StateAfter  any
	Verdict     *string
	Outputs     map[string]any
	RuleVersion int
	Reason      string
}

// ModuleTransitionRow is a stored judgment.
type ModuleTransitionRow struct {
	ModuleTransitionInput
	Id        string
	CreatedAt int64
}

// HistoryQuery pages queue or execution facts.
type HistoryQuery struct {
	NodeId *string
	After  *int
	Limit  *int
}

// QueueHistoryPage is one queue page.
type QueueHistoryPage struct {
	Items []QueueRow
	Next  *int64
}

// ExecutionHistoryItem is one frozen execution plus its cursor.
type ExecutionHistoryItem struct {
	Cursor int64
	ExecutionRow
}

// ExecutionHistoryPage is one execution page.
type ExecutionHistoryPage struct {
	Items []ExecutionHistoryItem
	Next  *int64
}

// KernelStore is the v2 durable layer on the shared task database.
type KernelStore struct {
	Store                   *TaskStore
	Db                      *sql.DB
	DB                      *sql.DB
	Content                 *KernelContent
	moduleTransactionActive bool
}

// NewKernelStore creates the kernel tables on the task store's database.
func NewKernelStore(store *TaskStore) *KernelStore {
	db := store.Db
	kernel := &KernelStore{Store: store, Db: db, DB: db, Content: NewKernelContent(db)}
	kernelExecScript(db, kernelSchema)
	kernel.migrate()
	return kernel
}

// kernelExecScript runs one schema script. The script holds several statements
// that are not separated by semicolons, so it is handed to the driver in one
// call, the way the TypeScript store runs it with db.exec.
func kernelExecScript(db *sql.DB, script string) {
	g5Exec(db, script)
}

func (k *KernelStore) migrate() {
	nodes := kernelColumns(k.Db, "kernel_nodes")
	for _, column := range []struct{ name, ddl string }{
		{"pause_ms", "INTEGER"}, {"pause_since", "INTEGER"},
		{"graph_paused", "INTEGER NOT NULL DEFAULT 0"}, {"node_paused", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if !nodes[column.name] {
			g5Exec(k.Db, "ALTER TABLE kernel_nodes ADD COLUMN "+column.name+" "+column.ddl)
		}
	}
	executions := kernelColumns(k.Db, "kernel_executions")
	state := kernelColumns(k.Db, "kernel_node_state")
	if !state["authorized_budget"] {
		g5Exec(k.Db, "ALTER TABLE kernel_node_state ADD COLUMN authorized_budget TEXT")
	}
	for _, column := range []struct{ name, ddl string }{
		{"token_budget", "TEXT"}, {"token_reservation", "INTEGER NOT NULL DEFAULT 0"},
		{"waiting_slot", "INTEGER NOT NULL DEFAULT 0"}, {"retries_used", "INTEGER NOT NULL DEFAULT 0"},
		{"resubmits_used", "INTEGER NOT NULL DEFAULT 0"}, {"pending_gap", "TEXT NOT NULL DEFAULT '[]'"},
		{"run_ms", "INTEGER"}, {"waiting_ms", "INTEGER"}, {"run_since", "INTEGER"}, {"waiting_since", "INTEGER"},
	} {
		if !executions[column.name] {
			g5Exec(k.Db, "ALTER TABLE kernel_executions ADD COLUMN "+column.name+" "+column.ddl)
		}
	}
	operations := kernelColumns(k.Db, "kernel_module_operations")
	if !operations["record_digest"] {
		g5Exec(k.Db, "ALTER TABLE kernel_module_operations ADD COLUMN record_digest TEXT")
	}
	if !operations["resource_receipt"] {
		g5Exec(k.Db, "ALTER TABLE kernel_module_operations ADD COLUMN resource_receipt TEXT")
	}
	if !operations["worker_active"] {
		g5Exec(k.Db, "ALTER TABLE kernel_module_operations ADD COLUMN worker_active INTEGER NOT NULL DEFAULT 0")
	}
	providers := kernelColumns(k.Db, "kernel_provider_calls")
	if !providers["model"] {
		g5Exec(k.Db, "ALTER TABLE kernel_provider_calls ADD COLUMN model TEXT")
	}
	if !providers["purpose"] {
		g5Exec(k.Db, "ALTER TABLE kernel_provider_calls ADD COLUMN purpose TEXT NOT NULL DEFAULT 'completion'")
	}
	if !providers["cost"] {
		g5Exec(k.Db, "ALTER TABLE kernel_provider_calls ADD COLUMN cost TEXT")
	}
	bindings := kernelColumns(k.Db, "kernel_node_bindings")
	if !bindings["environment"] {
		g5Exec(k.Db, "ALTER TABLE kernel_node_bindings ADD COLUMN environment TEXT")
	}
	if !bindings["role"] {
		g5Exec(k.Db, "ALTER TABLE kernel_node_bindings ADD COLUMN role TEXT")
	}
	deliveries := kernelColumns(k.Db, "kernel_deliveries")
	if !deliveries["source"] {
		g5Exec(k.Db, "ALTER TABLE kernel_deliveries ADD COLUMN source TEXT NOT NULL DEFAULT 'submission'")
	}
	queue := kernelColumns(k.Db, "kernel_queue")
	if !queue["reason"] {
		g5Exec(k.Db, "ALTER TABLE kernel_queue ADD COLUMN reason TEXT")
	}
	if !queue["generation"] {
		g5Exec(k.Db, "ALTER TABLE kernel_queue ADD COLUMN generation INTEGER NOT NULL DEFAULT 0")
	}
	budgets := kernelColumns(k.Db, "kernel_node_state")
	for _, column := range []struct{ name, ddl string }{
		{"used", "ALTER TABLE kernel_node_state ADD COLUMN used INTEGER NOT NULL DEFAULT 0"},
		{"reserved", "ALTER TABLE kernel_node_state ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0"},
		{"last_committed", "ALTER TABLE kernel_node_state ADD COLUMN last_committed INTEGER NOT NULL DEFAULT 0"},
	} {
		if !budgets[column.name] {
			g5Exec(k.Db, column.ddl)
		}
	}
}

func kernelColumns(db *sql.DB, table string) map[string]bool {
	out := map[string]bool{}
	for _, row := range g5Query(db, "PRAGMA table_info("+table+")") {
		out[g5Str(row["name"])] = true
	}
	return out
}

func (k *KernelStore) tx(action func() any) any {
	if k.Store.IsTransaction() {
		return action()
	}
	return k.Store.Transaction(action)
}

// PublishRevision parses and inserts one revision in its own transaction.
func (k *KernelStore) PublishRevision(taskID string, definition GraphDefinition, reason string, version ...int) *RevisionRow {
	if strings.TrimSpace(reason) == "" {
		Raise("invalid_definition", "A revision reason is required")
	}
	parsed := ParseGraphDefinition(definition)
	return k.tx(func() any { return k.InsertRevision(taskID, parsed, reason, version...) }).(*RevisionRow)
}

// InsertRevision writes one revision without opening a transaction.
func (k *KernelStore) InsertRevision(taskID string, definition GraphDefinition, reason string, version ...int) *RevisionRow {
	if strings.TrimSpace(reason) == "" {
		Raise("invalid_definition", "A revision reason is required")
	}
	next := 0
	if len(version) > 0 {
		next = version[0]
	} else {
		row, _ := g5One(k.Db, "SELECT COALESCE(MAX(version),0) AS v FROM kernel_revisions WHERE task_id=?", taskID)
		next = int(g5Int(row["v"])) + 1
	}
	if _, exists := g5One(k.Db, "SELECT 1 FROM kernel_revisions WHERE task_id=? AND version=?", taskID, next); exists {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(next))+" already exists and is immutable")
	}
	createdAt := NowMillis()
	g5Exec(k.Db, "INSERT INTO kernel_revisions(task_id,version,definition,reason,created_at) VALUES(?,?,?,?,?)", taskID, next, CanonicalJSON(definition), reason, createdAt)
	return &RevisionRow{TaskId: taskID, Version: next, Definition: definition, Reason: reason, CreatedAt: createdAt}
}

// Revision reads one immutable definition.
func (k *KernelStore) Revision(taskID string, version int) *RevisionRow {
	row, ok := g5One(k.Db, "SELECT definition,reason,created_at FROM kernel_revisions WHERE task_id=? AND version=?", taskID, version)
	if !ok {
		return nil
	}
	var definition GraphDefinition
	if err := json.Unmarshal([]byte(g5Str(row["definition"])), &definition); err != nil {
		panic(err)
	}
	return &RevisionRow{TaskId: taskID, Version: version, Definition: definition, Reason: g5Str(row["reason"]), CreatedAt: g5Int(row["created_at"])}
}

// LatestRevision is the highest published version, or nil.
func (k *KernelStore) LatestRevision(taskID string) *RevisionRow {
	row, ok := g5One(k.Db, "SELECT version FROM kernel_revisions WHERE task_id=? ORDER BY version DESC LIMIT 1", taskID)
	if !ok {
		return nil
	}
	return k.Revision(taskID, int(g5Int(row["version"])))
}

// ModuleTransaction runs a module judgment in the current transaction or a new one.
func (k *KernelStore) ModuleTransaction(action func() any) any {
	if k.moduleTransactionActive {
		return action()
	}
	return k.Store.Transaction(func() any {
		k.moduleTransactionActive = true
		defer func() { k.moduleTransactionActive = false }()
		return action()
	})
}

func (input AdmitNodeInput) instance() string {
	if input.InstanceId != "" {
		return input.InstanceId
	}
	return input.InstanceID
}

// AdmitNode inserts one node and inherits a recorded graph pause.
func (k *KernelStore) AdmitNode(taskID string, revisionVersion int, nodeID string, input AdmitNodeInput) {
	revision := k.Revision(taskID, revisionVersion)
	if revision == nil {
		Raise("invalid_definition", "Unknown revision "+kernelItoa(int64(revisionVersion)))
	}
	node, ok := revision.Definition.Nodes[nodeID]
	if !ok {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(revisionVersion))+" has no node "+nodeID)
	}
	kind := input.Kind
	if kind == "" {
		kind = "agent"
	}
	g5Exec(k.Db, "INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status) VALUES(?,?,?,?,?,?,?)", taskID, revisionVersion, nodeID, input.instance(), kind, CanonicalJSON(node), "idle")
	if _, paused := g5One(k.Db, "SELECT 1 FROM kernel_nodes WHERE task_id=? AND graph_paused=1", taskID); paused {
		SetNativePause(k.Store, taskID, true, "", 0)
	}
}

// AdmitModule inserts one module row.
func (k *KernelStore) AdmitModule(taskID string, revisionVersion int, moduleID string, input AdmitModuleInput) {
	revision := k.Revision(taskID, revisionVersion)
	if revision == nil {
		Raise("invalid_definition", "Unknown revision "+kernelItoa(int64(revisionVersion)))
	}
	if _, ok := revision.Definition.Modules[moduleID]; !ok {
		Raise("invalid_definition", "Revision "+kernelItoa(int64(revisionVersion))+" has no module "+moduleID)
	}
	g5Exec(k.Db, "INSERT INTO kernel_modules(task_id,revision_version,module_id,module_type,trigger) VALUES(?,?,?,?,?)", taskID, revisionVersion, moduleID, input.ModuleType, input.Trigger)
}

// StartExecution opens a running execution, or resumes a blocked one with the same id.
func (k *KernelStore) StartExecution(taskID string, input StartExecutionRequest) ExecutionRow {
	return k.Store.Transaction(func() any {
		existing := k.Execution(input.ExecutionId)
		if existing != nil {
			if existing.TaskId != taskID || existing.NodeId != input.NodeId || (existing.SubmissionId != nil && !hasDurableNodeCompletion(k.Store.Path, input.ExecutionId)) || existing.State != "blocked" {
				Raise("invalid_execution", "Execution cannot be started again")
			}
			g5Exec(k.Db, "UPDATE kernel_executions SET state='running',ended_at=NULL,run_since=?,waiting_since=NULL,waiting_slot=0 WHERE id=?", NowMillis(), input.ExecutionId)
		} else {
			startedAt := NowMillis()
			var budget any
			if input.TokenBudget != nil {
				raw, err := json.Marshal(input.TokenBudget)
				if err != nil {
					panic(err)
				}
				budget = string(raw)
			}
			g5Exec(k.Db, "INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at,token_budget,run_ms,waiting_ms,run_since) VALUES(?,?,?,?,0,?,?,?,0,0,?)", input.ExecutionId, taskID, input.NodeId, input.RevisionVersion, "running", startedAt, budget, startedAt)
		}
		execution := k.Execution(input.ExecutionId)
		g5Exec(k.Db, "UPDATE kernel_nodes SET status='running' WHERE task_id=? AND node_id=?", taskID, input.NodeId)
		k.Store.Event(taskID, "graph.execution.started", map[string]any{"executionId": input.ExecutionId, "nodeId": input.NodeId, "revisionVersion": execution.RevisionVersion})
		return *execution
	}).(ExecutionRow)
}

// BlockQueued parks a claimed item back on the queue.
func (k *KernelStore) BlockQueued(taskID string, seq int64) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state='queued' WHERE task_id=? AND seq=? AND state='claimed'", taskID, seq)
}

// FinishExecution records a terminal execution state.
func (k *KernelStore) FinishExecution(executionID, state string) {
	finish := func() {
		now := NowMillis()
		CloseNativeExecutionTiming(k.Store, executionID, now)
		g5Exec(k.Db, "UPDATE kernel_executions SET state=?, ended_at=? WHERE id=?", state, now, executionID)
	}
	if k.Store.IsTransaction() {
		finish()
		return
	}
	k.Store.Transaction(func() any { finish(); return nil })
}

// Execution reads one execution row.
func (k *KernelStore) Execution(executionID string) *ExecutionRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_executions WHERE id=?", executionID)
	if !ok {
		return nil
	}
	var submission *string
	if row["submission_id"] != nil {
		text := g5Str(row["submission_id"])
		submission = &text
	}
	var ended *int64
	if row["ended_at"] != nil {
		value := g5Int(row["ended_at"])
		ended = &value
	}
	var budget *TokenBudget
	if row["token_budget"] != nil && g5Str(row["token_budget"]) != "" {
		parsed := &TokenBudget{}
		if err := json.Unmarshal([]byte(g5Str(row["token_budget"])), parsed); err != nil {
			panic(err)
		}
		budget = parsed
	}
	gap := []string{}
	if row["pending_gap"] != nil && g5Str(row["pending_gap"]) != "" {
		if err := json.Unmarshal([]byte(g5Str(row["pending_gap"])), &gap); err != nil {
			panic(err)
		}
	}
	return &ExecutionRow{
		Id: g5Str(row["id"]), TaskId: g5Str(row["task_id"]), NodeId: g5Str(row["node_id"]), RevisionVersion: int(g5Int(row["revision_version"])),
		Attempt: int(g5Int(row["attempt"])), RetriesUsed: int(g5Int(row["retries_used"])), ResubmitsUsed: int(g5Int(row["resubmits_used"])),
		PendingGap: gap, TokenBudget: budget, State: g5Str(row["state"]), SubmissionId: submission,
		MissingRequired: g5Int(row["missing_required"]) == 1, StartedAt: g5Int(row["started_at"]), EndedAt: ended,
	}
}

// NoteExecutionContinuation counts a retry or resubmit before it is sent.
func (k *KernelStore) NoteExecutionContinuation(executionID, kind string, missing []string) {
	if missing == nil {
		missing = []string{}
	}
	column := "resubmits_used"
	if kind == "retry" {
		column = "retries_used"
	}
	raw, err := json.Marshal(missing)
	if err != nil {
		panic(err)
	}
	g5Exec(k.Db, "UPDATE kernel_executions SET "+column+"="+column+"+1,pending_gap=? WHERE id=?", string(raw), executionID)
}

// NoteExecutionAttempt increments the attempt counter and returns it.
func (k *KernelStore) NoteExecutionAttempt(executionID string) int {
	g5Exec(k.Db, "UPDATE kernel_executions SET attempt=attempt+1 WHERE id=?", executionID)
	return k.Execution(executionID).Attempt
}

func (k *KernelStore) assertOutputsOpen(taskID string) {
	phase := k.Store.Task(taskID).Phase
	if phase == "stopping" || phase == "stopped" || phase == "completed" {
		Raise("invalid_graph", "Graph "+taskID+" is "+phase+"; new outputs are closed")
	}
}

// Submit validates and writes one submission, or replays an identical one.
func (k *KernelStore) Submit(executionID string, request SubmitRequest) SubmitReceipt {
	return k.Store.Transaction(func() any {
		execution := k.Execution(executionID)
		if execution == nil {
			Raise("invalid_submit", "Unknown execution "+executionID)
		}
		existing, ok := g5One(k.Db, "SELECT id, content_digest FROM kernel_submissions WHERE execution_id=?", executionID)
		if ok {
			return k.replayOrRefuse(*execution, request, g5Str(existing["id"]), g5Str(existing["content_digest"]))
		}
		if execution.State != "running" {
			Raise("invalid_submit", "Execution "+execution.Id+" is "+execution.State+" and has no submission to replay")
		}
		k.assertOutputsOpen(execution.TaskId)
		revision := k.Revision(execution.TaskId, execution.RevisionVersion)
		node, nodeOK := revision.Definition.Nodes[execution.NodeId]
		if !nodeOK {
			Raise("invalid_submit", "Execution node "+execution.NodeId+" is not in revision "+kernelItoa(int64(revision.Version)))
		}
		if request.Outputs == nil {
			Raise("invalid_submit", "outputs must be a named object")
		}
		// TODO(port): output and edge walks are sorted; TypeScript Object.entries keeps insertion order.
		for _, name := range portKeys(request.Outputs) {
			output := request.Outputs[name]
			declared, declaredOK := node.Outputs[name]
			if !declaredOK {
				Raise("invalid_submit", "Node "+execution.NodeId+" has no output "+name)
			}
			if !output.Enable {
				continue
			}
			spec, specOK := revision.Definition.Protocols[declared.Protocol]
			if !specOK {
				Raise("invalid_submit", "Output "+name+" references undeclared protocol "+declared.Protocol)
			}
			if defect := ValidateProtocolValue(spec, output.Value, execution.NodeId+"."+name); defect != nil && *defect != "" {
				Raise("invalid_submit", "Output "+name+" does not satisfy "+declared.Protocol+": "+*defect)
			}
		}
		queue, queued := g5One(k.Db, "SELECT kind FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed' LIMIT 1", execution.TaskId, execution.NodeId)
		chat := queued && g5Str(queue["kind"]) == "chat"
		required := node.Submission.Required
		anyOf := node.Submission.RequiredAnyOf
		if chat {
			required = nil
			anyOf = nil
		}
		if len(anyOf) > 0 {
			enabledAny := false
			for _, name := range anyOf {
				if output, exists := request.Outputs[name]; exists && output.Enable {
					enabledAny = true
				}
			}
			if !enabledAny {
				Raise("invalid_submit", "Required output(s) not enabled: "+strings.Join(anyOf, ", "))
			}
		}
		missing := []string{}
		for _, name := range required {
			output, exists := request.Outputs[name]
			if !exists || !output.Enable {
				missing = append(missing, name)
			}
		}
		if len(missing) > 0 {
			Raise("invalid_submit", "Required output(s) not enabled: "+strings.Join(missing, ", "))
		}
		connections := k.LatestRevision(execution.TaskId)
		type target struct {
			edgeID, to, protocol string
			value                any
		}
		targets := []target{}
		enabled := []string{}
		for _, name := range portKeys(request.Outputs) {
			if request.Outputs[name].Enable {
				enabled = append(enabled, name)
			}
		}
		for _, name := range enabled {
			output := request.Outputs[name]
			for _, edgeID := range portKeys(connections.Definition.Edges) {
				edge := connections.Definition.Edges[edgeID]
				if edge.From != execution.NodeId+"."+name || !edge.Enabled {
					continue
				}
				owner, port := kernelSplitEndpoint(edge.To)
				targetNode, nodeTarget := connections.Definition.Nodes[owner]
				targetModule, moduleTarget := connections.Definition.Modules[owner]
				var ref ProtocolRef
				found := false
				if nodeTarget {
					ref, found = targetNode.Inputs[port]
				}
				if !found && moduleTarget {
					ref, found = targetModule.Inputs[port]
				}
				if !found {
					Raise("invalid_submit", "Edge "+edgeID+" targets unknown input "+edge.To)
				}
				if spec, specOK := connections.Definition.Protocols[ref.Protocol]; specOK {
					if defect := ValidateProtocolValue(spec, output.Value, edge.To); defect != nil && *defect != "" {
						Raise("invalid_submit", "Delivery "+edgeID+" to "+edge.To+" does not satisfy "+ref.Protocol+": "+*defect)
					}
				}
				targets = append(targets, target{edgeID: edgeID, to: edge.To, value: output.Value, protocol: ref.Protocol})
			}
		}
		for _, name := range enabled {
			k.publishGraphOutputs(execution.TaskId, execution.NodeId+"."+name, request.Outputs[name].Value, request.SubmissionId, connections)
		}
		digest := ContentDigest(CanonicalJSON(map[string]any{"outputs": request.Outputs}))
		createdAt := NowMillis()
		g5Exec(k.Db, "INSERT INTO kernel_submissions(id,task_id,execution_id,content_digest,outputs,created_at) VALUES(?,?,?,?,?,?)", request.SubmissionId, execution.TaskId, executionID, digest, k.Content.Encode(request.Outputs), createdAt)
		deliveries := []DeliveryRow{}
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", execution.TaskId)
		nextSeq := g5Int(seqRow["s"])
		for index, item := range targets {
			id := graphUUID()
			seq := nextSeq + int64(index) + 1
			edge := connections.Definition.Edges[item.edgeID]
			g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, execution.TaskId, request.SubmissionId, item.edgeID, edge.From, item.to, k.Content.Encode(item.value), item.protocol, connections.Version, seq, "accepted", createdAt)
			owner, port := kernelSplitEndpoint(item.to)
			if _, moduleTarget := connections.Definition.Modules[owner]; moduleTarget {
				g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, execution.TaskId, owner)
			} else {
				g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)", execution.TaskId, owner, "delivery", k.Content.Encode(map[string]any{"deliveryId": id, "input": port, "value": item.value}), createdAt)
			}
			submission := request.SubmissionId
			edgeID := item.edgeID
			deliveries = append(deliveries, DeliveryRow{
				Id: id, TaskId: execution.TaskId, SubmissionId: &submission, EdgeId: &edgeID, FromEndpoint: edge.From, ToEndpoint: item.to,
				Value: item.value, Protocol: item.protocol, RevisionVersion: connections.Version, Seq: seq, State: "accepted", Source: "submission", CreatedAt: createdAt,
			})
		}
		g5Exec(k.Db, "UPDATE kernel_executions SET submission_id=?, missing_required=0 WHERE id=?", request.SubmissionId, executionID)
		_, landed := g5One(k.Db, "SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1", execution.TaskId, request.SubmissionId)
		return SubmitReceipt{SubmissionId: request.SubmissionId, Replayed: false, Deliveries: deliveries, NoRecipients: len(deliveries) == 0 && !landed}
	}).(SubmitReceipt)
}

func (k *KernelStore) replayOrRefuse(execution ExecutionRow, request SubmitRequest, id, stored string) SubmitReceipt {
	digest := CanonicalJSON(map[string]any{"outputs": request.Outputs})
	if id == request.SubmissionId && (stored == digest || stored == ContentDigest(digest)) {
		deliveries := k.DeliveriesFor(execution.Id)
		_, landed := g5One(k.Db, "SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1", execution.TaskId, request.SubmissionId)
		return SubmitReceipt{SubmissionId: request.SubmissionId, Replayed: true, Deliveries: deliveries, NoRecipients: len(deliveries) == 0 && !landed}
	}
	Raise("invalid_submit", "Execution "+execution.Id+" already submitted; only one valid submission per execution is allowed")
	return SubmitReceipt{}
}

// DeliverDirect accepts one external input and lands it.
func (k *KernelStore) DeliverDirect(taskID, endpoint string, value any) DirectDelivery {
	revision := k.LatestRevision(taskID)
	if revision == nil {
		Raise("invalid_graph", "Graph "+taskID+" has no definition")
	}
	dot := strings.IndexByte(endpoint, '.')
	owner, port := kernelSplitEndpoint(endpoint)
	var ref ProtocolRef
	found := false
	if node, ok := revision.Definition.Nodes[owner]; ok {
		ref, found = node.Inputs[port]
	}
	if !found {
		if module, ok := revision.Definition.Modules[owner]; ok {
			ref, found = module.Inputs[port]
		}
	}
	if dot < 1 || !found {
		Raise("invalid_input", "Unknown input "+endpoint)
	}
	if defect := ValidateProtocolValue(revision.Definition.Protocols[ref.Protocol], value, endpoint); defect != nil && *defect != "" {
		Raise("invalid_input", *defect)
	}
	return k.Store.Transaction(func() any {
		id := graphUUID()
		createdAt := NowMillis()
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"]) + 1
		g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, nil, "main", endpoint, k.Content.Encode(value), ref.Protocol, revision.Version, seq, "accepted", createdAt, "direct")
		delivery := DeliveryRow{Id: id, TaskId: taskID, ToEndpoint: endpoint, FromEndpoint: "main", Value: value, Protocol: ref.Protocol, RevisionVersion: revision.Version, Seq: seq, State: "accepted", Source: "direct", CreatedAt: createdAt}
		if _, moduleTarget := revision.Definition.Modules[owner]; moduleTarget {
			g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, taskID, owner)
			k.Store.Event(taskID, "graph.delivery.accepted", map[string]any{"deliveryId": id, "endpoint": endpoint})
			return DirectDelivery{Delivery: delivery}
		}
		queue := k.EnqueueInCurrentTransaction(taskID, QueueInsert{NodeId: owner, Kind: "delivery", Payload: map[string]any{"deliveryId": id, "input": port, "value": value, "protocol": ref.Protocol, "revisionVersion": revision.Version}})
		return DirectDelivery{Delivery: delivery, Queue: &queue}
	}).(DirectDelivery)
}

func (k *KernelStore) deliveryFrom(row map[string]any) DeliveryRow {
	var submission *string
	if row["submission_id"] != nil {
		text := g5Str(row["submission_id"])
		submission = &text
	}
	var edge *string
	if row["edge_id"] != nil {
		text := g5Str(row["edge_id"])
		edge = &text
	}
	source := "submission"
	if g5Str(row["source"]) == "direct" || g5Str(row["source"]) == "module" {
		source = g5Str(row["source"])
	}
	return DeliveryRow{
		Id: g5Str(row["id"]), TaskId: g5Str(row["task_id"]), SubmissionId: submission, EdgeId: edge,
		FromEndpoint: g5Str(row["from_endpoint"]), ToEndpoint: g5Str(row["to_endpoint"]), Value: k.Content.Decode(g5Str(row["value"])),
		Protocol: g5Str(row["protocol"]), RevisionVersion: int(g5Int(row["revision_version"])), Seq: g5Int(row["seq"]),
		State: "accepted", Source: source, CreatedAt: g5Int(row["created_at"]),
	}
}

// DeliveriesForEdge lists deliveries through one edge, newest first.
func (k *KernelStore) DeliveriesForEdge(taskID, edgeID string) []DeliveryRow {
	rows := g5Query(k.Db, "SELECT * FROM kernel_deliveries WHERE task_id=? AND edge_id=? ORDER BY seq DESC", taskID, edgeID)
	out := make([]DeliveryRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, k.deliveryFrom(row))
	}
	return out
}

// DeliveriesFor lists deliveries of one execution in acceptance order.
func (k *KernelStore) DeliveriesFor(executionID string) []DeliveryRow {
	rows := g5Query(k.Db, `SELECT d.* FROM kernel_deliveries d JOIN kernel_submissions s ON s.id = d.submission_id WHERE s.execution_id = ? ORDER BY d.seq`, executionID)
	out := make([]DeliveryRow, 0, len(rows))
	for _, row := range rows {
		out = append(out, k.deliveryFrom(row))
	}
	return out
}

// RecordModuleDelivery lands one module emit.
func (k *KernelStore) RecordModuleDelivery(taskID, moduleID, edgeID, fromEndpoint, toEndpoint, protocol string, value any, revisionVersion int) DeliveryRow {
	_ = moduleID
	return k.Store.Transaction(func() any {
		id := graphUUID()
		createdAt := NowMillis()
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"]) + 1
		g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, edgeID, fromEndpoint, toEndpoint, k.Content.Encode(value), protocol, revisionVersion, seq, "accepted", createdAt, "module")
		edge := edgeID
		return DeliveryRow{Id: id, TaskId: taskID, EdgeId: &edge, FromEndpoint: fromEndpoint, ToEndpoint: toEndpoint, Value: value, Protocol: protocol, RevisionVersion: revisionVersion, Seq: seq, State: "accepted", Source: "module", CreatedAt: createdAt}
	}).(DeliveryRow)
}

func (k *KernelStore) publishGraphOutputs(taskID, endpoint string, value any, sourceID string, revision *RevisionRow) {
	// TODO(port): graph output walks are sorted; TypeScript Object.entries keeps insertion order.
	for _, name := range portKeys(revision.Definition.Outputs) {
		output := revision.Definition.Outputs[name]
		if output.From != endpoint {
			continue
		}
		resultID := graphUUID()
		changes, _ := g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_graph_results(id,task_id,output_name,source_id,value,protocol,revision_version,created_at) VALUES(?,?,?,?,?,?,?,?)", resultID, taskID, name, sourceID, k.Content.Encode(value), output.Protocol, revision.Version, NowMillis())
		if changes == 0 {
			continue
		}
		data := map[string]any{"graphId": taskID, "output": name, "sourceId": sourceID, "resultId": resultID, "revision": revision.Version}
		WakeMaster(k.Store, WakeIntent{TaskID: taskID, Kind: "graph_output", DedupeKey: taskID + ":" + name + ":" + sourceID, Data: data, HasData: true})
		k.Store.Event(taskID, "graph.output", map[string]any{"output": name, "sourceId": sourceID, "resultId": resultID, "revision": revision.Version})
		if revision.Definition.Completion != nil && revision.Definition.Completion.On == name {
			g5Exec(k.Db, "INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1", taskID)
			g5Exec(k.Db, "UPDATE tasks SET phase='completing' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')", taskID)
		}
	}
}

// BroadcastModule validates and lands every enabled output of one module.
func (k *KernelStore) BroadcastModule(taskID, moduleID string, outputs map[string]any, transitionID string) []DeliveryRow {
	return k.Store.Transaction(func() any {
		if transitionID != "" {
			if row, ok := g5One(k.Db, "SELECT routed FROM kernel_transition_outbox WHERE transition_id=?", transitionID); ok && g5Int(row["routed"]) == 1 {
				return []DeliveryRow{}
			}
		}
		k.assertOutputsOpen(taskID)
		revision := k.LatestRevision(taskID)
		module, moduleOK := revision.Definition.Modules[moduleID]
		if revision == nil || !moduleOK {
			Raise("invalid_output", "Unknown module "+moduleID)
		}
		if revision == nil {
			Raise("invalid_definition", "Unknown module "+moduleID)
		}
		type target struct {
			edgeID, endpoint, protocol, owner, port string
			value                                   any
			module                                  bool
		}
		targets := []target{}
		// TODO(port): module output and edge walks are sorted; TypeScript Object.entries keeps insertion order.
		for _, name := range portKeys(outputs) {
			value := outputs[name]
			output, outputOK := module.Outputs[name]
			if !outputOK {
				Raise("invalid_output", "Unknown output "+moduleID+"."+name)
			}
			protocol, protocolOK := revision.Definition.Protocols[output.Protocol]
			if !protocolOK {
				Raise("invalid_definition", "Unknown protocol "+output.Protocol)
			}
			if defect := ValidateProtocolValue(protocol, value, moduleID+"."+name); defect != nil && *defect != "" {
				Raise("invalid_output", *defect)
			}
			for _, edgeID := range portKeys(revision.Definition.Edges) {
				edge := revision.Definition.Edges[edgeID]
				if !edge.Enabled || edge.From != moduleID+"."+name {
					continue
				}
				owner, port := kernelSplitEndpoint(edge.To)
				targetModule, isModule := revision.Definition.Modules[owner]
				var input ProtocolRef
				found := false
				if isModule {
					input, found = targetModule.Inputs[port]
				} else if node, ok := revision.Definition.Nodes[owner]; ok {
					input, found = node.Inputs[port]
				}
				targetProtocol, protocolFound := revision.Definition.Protocols[input.Protocol]
				if !found || !protocolFound {
					Raise("invalid_definition", "Unknown input "+edge.To)
				}
				if defect := ValidateProtocolValue(targetProtocol, value, edge.To); defect != nil && *defect != "" {
					Raise("invalid_output", *defect)
				}
				targets = append(targets, target{edgeID: edgeID, endpoint: edge.To, protocol: input.Protocol, value: value, owner: owner, port: port, module: isModule})
			}
		}
		sourceID := transitionID
		if sourceID == "" {
			sourceID = graphUUID()
		}
		for _, name := range portKeys(outputs) {
			k.publishGraphOutputs(taskID, moduleID+"."+name, outputs[name], sourceID, revision)
		}
		seqRow, _ := g5One(k.Db, "SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?", taskID)
		seq := g5Int(seqRow["s"])
		deliveries := []DeliveryRow{}
		for _, item := range targets {
			id := graphUUID()
			createdAt := NowMillis()
			seq++
			edge := revision.Definition.Edges[item.edgeID]
			g5Exec(k.Db, "INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, nil, item.edgeID, edge.From, item.endpoint, k.Content.Encode(item.value), item.protocol, revision.Version, seq, "accepted", createdAt, "module")
			if item.module {
				g5Exec(k.Db, "INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)", id, taskID, item.owner)
			} else {
				k.EnqueueDelivery(taskID, item.owner, map[string]any{"deliveryId": id, "input": item.port, "value": item.value})
			}
			edgeID := item.edgeID
			deliveries = append(deliveries, DeliveryRow{Id: id, TaskId: taskID, EdgeId: &edgeID, FromEndpoint: edge.From, ToEndpoint: item.endpoint, Value: item.value, Protocol: item.protocol, RevisionVersion: revision.Version, Seq: seq, State: "accepted", Source: "module", CreatedAt: createdAt})
		}
		if transitionID != "" {
			g5Exec(k.Db, "UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id=?", transitionID)
		}
		return deliveries
	}).([]DeliveryRow)
}

// EnqueueDelivery queues a node delivery without a submission.
func (k *KernelStore) EnqueueDelivery(taskID, nodeID string, payload any) {
	g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)", taskID, nodeID, "delivery", k.Content.Encode(payload), NowMillis())
}

// EnqueueInCurrentTransaction appends one queue row for a caller already inside a transaction.
func (k *KernelStore) EnqueueInCurrentTransaction(taskID string, input QueueInsert) QueueRow {
	createdAt := NowMillis()
	_, lastID := g5Exec(k.Db, "INSERT INTO kernel_queue(task_id,node_id,kind,payload,state,created_at) VALUES(?,?,?,?,?,?)", taskID, input.NodeId, input.Kind, k.Content.Encode(input.Payload), "queued", createdAt)
	return QueueRow{Seq: lastID, TaskId: taskID, NodeId: input.NodeId, Kind: input.Kind, Payload: input.Payload, State: "queued", CreatedAt: createdAt}
}

// Enqueue appends one input, joining the current transaction when one is open.
func (k *KernelStore) Enqueue(taskID string, input QueueInsert) QueueRow {
	if k.Store.IsTransaction() {
		return k.EnqueueInCurrentTransaction(taskID, input)
	}
	return k.Store.Transaction(func() any { return k.EnqueueInCurrentTransaction(taskID, input) }).(QueueRow)
}

func (k *KernelStore) historyWindow(query HistoryQuery) (int, int) {
	after := 0
	if query.After != nil {
		after = *query.After
	}
	limit := 100
	if query.Limit != nil {
		limit = *query.Limit
	}
	if !isSafeInteger(after) || after < 0 || !isSafeInteger(limit) || limit < 1 || limit > 200 {
		Raise("invalid_query", "History requires a non-negative after cursor and a limit from 1 to 200")
	}
	return after, limit
}

func (k *KernelStore) queueFrom(row map[string]any) QueueRow {
	var reason *string
	if row["reason"] != nil {
		text := g5Str(row["reason"])
		reason = &text
	}
	return QueueRow{
		Seq: g5Int(row["seq"]), TaskId: g5Str(row["task_id"]), NodeId: g5Str(row["node_id"]), Kind: g5Str(row["kind"]),
		Payload: k.Content.Decode(g5Str(row["payload"])), Generation: g5Int(row["generation"]), Reason: reason, State: g5Str(row["state"]), CreatedAt: g5Int(row["created_at"]),
	}
}

// QueueHistory pages queue rows, including failed inputs.
func (k *KernelStore) QueueHistory(taskID string, query HistoryQuery) QueueHistoryPage {
	after, limit := k.historyWindow(query)
	var node any
	if query.NodeId != nil {
		node = *query.NodeId
	}
	rows := g5Query(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND seq>? AND (? IS NULL OR node_id=?) ORDER BY seq LIMIT ?", taskID, after, node, node, limit+1)
	count := limit
	if count > len(rows) {
		count = len(rows)
	}
	items := make([]QueueRow, 0, count)
	for _, row := range rows[:count] {
		items = append(items, k.queueFrom(row))
	}
	var next *int64
	if len(rows) > limit && len(items) > 0 {
		seq := items[len(items)-1].Seq
		next = &seq
	}
	return QueueHistoryPage{Items: items, Next: next}
}

// ExecutionHistory pages frozen execution facts.
func (k *KernelStore) ExecutionHistory(taskID string, query HistoryQuery) ExecutionHistoryPage {
	after, limit := k.historyWindow(query)
	var node any
	if query.NodeId != nil {
		node = *query.NodeId
	}
	rows := g5Query(k.Db, "SELECT rowid AS cursor,id FROM kernel_executions WHERE task_id=? AND rowid>? AND (? IS NULL OR node_id=?) ORDER BY rowid LIMIT ?", taskID, after, node, node, limit+1)
	count := limit
	if count > len(rows) {
		count = len(rows)
	}
	items := []ExecutionHistoryItem{}
	for _, row := range rows[:count] {
		items = append(items, ExecutionHistoryItem{Cursor: g5Int(row["cursor"]), ExecutionRow: *k.Execution(g5Str(row["id"]))})
	}
	var next *int64
	if len(rows) > limit && len(items) > 0 {
		cursor := items[len(items)-1].Cursor
		next = &cursor
	}
	return ExecutionHistoryPage{Items: items, Next: next}
}

// NextQueued is the oldest queued item, or nil.
func (k *KernelStore) NextQueued(taskID, nodeID string) *QueueRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND node_id=? AND state='queued' ORDER BY seq LIMIT 1", taskID, nodeID)
	if !ok {
		return nil
	}
	queued := k.queueFrom(row)
	return &queued
}

// ClaimQueued marks one queued item claimed.
func (k *KernelStore) ClaimQueued(taskID string, seq int64) *QueueRow {
	return k.Store.Transaction(func() any {
		row, ok := g5One(k.Db, "SELECT * FROM kernel_queue WHERE task_id=? AND seq=?", taskID, seq)
		if !ok {
			Raise("invalid_queue", "Unknown queue item "+kernelItoa(seq))
		}
		if g5Str(row["state"]) != "queued" {
			Raise("invalid_queue", "Queue item "+kernelItoa(seq)+" is "+g5Str(row["state"]))
		}
		g5Exec(k.Db, "UPDATE kernel_queue SET state='claimed' WHERE task_id=? AND seq=?", taskID, seq)
		queued := k.queueFrom(row)
		queued.State = "claimed"
		return &queued
	}).(*QueueRow)
}

// FinishQueued sets a terminal queue state.
func (k *KernelStore) FinishQueued(taskID string, seq int64, state string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET state=? WHERE task_id=? AND seq=?", state, taskID, seq)
}

// NodeState returns retry counters, creating nothing until a later write.
func (k *KernelStore) NodeState(taskID, nodeID string) NodeStateRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return NodeStateRow{}
	}
	return NodeStateRow{
		Attempts: int(g5Int(row["attempts"])), ResubmitsUsed: int(g5Int(row["resubmits_used"])),
		RetriesAllowed: kernelOptInt(row["retries_allowed"]), ResubmitsAllowed: kernelOptInt(row["resubmits_allowed"]),
		Paused: g5Int(row["paused"]) == 1, Rebinds: int(g5Int(row["rebinds"])),
	}
}

// AuthorizedBudget is the explicit user quota, or nil when unset.
func (k *KernelStore) AuthorizedBudget(taskID, nodeID string) *TokenBudget {
	row, ok := g5One(k.Db, "SELECT authorized_budget FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok || row["authorized_budget"] == nil || g5Str(row["authorized_budget"]) == "" {
		return nil
	}
	budget := &TokenBudget{}
	if err := json.Unmarshal([]byte(g5Str(row["authorized_budget"])), budget); err != nil {
		panic(err)
	}
	return budget
}

// SetAuthorizedBudget records an explicit quota. Nil tokens means unlimited.
func (k *KernelStore) SetAuthorizedBudget(taskID, nodeID string, tokens *int64) {
	phase := k.Store.Task(taskID).Phase
	if phase == "completed" || phase == "stopping" || phase == "stopped" {
		Raise("invalid_graph", "Ended graph cannot change budget")
	}
	definition := k.LatestRevision(taskID)
	if definition == nil {
		Raise("not_found", "Unknown agent node")
	}
	if _, ok := definition.Definition.Nodes[nodeID]; !ok || k.NodeStatus(taskID, nodeID) == "retired" {
		Raise("not_found", "Unknown agent node")
	}
	if tokens != nil && (!isSafeInteger(*tokens) || *tokens <= 0) {
		Raise("invalid_input", "Budget must be a positive integer or null")
	}
	k.ensureNodeState(taskID, nodeID)
	budget := TokenBudget{Unlimited: tokens == nil}
	if tokens != nil {
		budget.Budget = float64(*tokens)
	}
	raw, err := json.Marshal(budget)
	if err != nil {
		panic(err)
	}
	g5Exec(k.Db, "UPDATE kernel_node_state SET authorized_budget=? WHERE task_id=? AND node_id=?", string(raw), taskID, nodeID)
}

// BudgetState reports spent and held tokens against a caller-supplied quota.
func (k *KernelStore) BudgetState(taskID, nodeID string, budget TokenBudget) NodeBudgetState {
	k.ensureNodeState(taskID, nodeID)
	row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
	return NodeBudgetState{Budget: budget.Budget, Unlimited: budget.Unlimited, Used: float64(g5Int(row["used"])), Reserved: float64(g5Int(row["reserved"]))}
}

// ReserveNodeTokens holds a reservation or refuses the send.
func (k *KernelStore) ReserveNodeTokens(taskID, nodeID string, budget TokenBudget, amount float64, executionID string) {
	if !isSafeInteger(amount) || amount < 0 {
		Raise("invalid_adapter", "A bounded token reservation is required")
	}
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
		if !budget.Unlimited && float64(g5Int(row["used"]))+float64(g5Int(row["reserved"]))+amount > budget.Budget {
			Raise("budget", "Token budget exhausted for node "+nodeID)
		}
		g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=reserved+? WHERE task_id=? AND node_id=?", int64(amount), taskID, nodeID)
		if executionID != "" {
			g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=? WHERE id=?", int64(amount), executionID)
		}
		return nil
	})
}

// ReleaseNodeTokens returns a hold.
func (k *KernelStore) ReleaseNodeTokens(taskID, nodeID string, amount float64, executionID string) {
	if !isSafeInteger(amount) || amount < 0 {
		return
	}
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=MAX(0,reserved-?) WHERE task_id=? AND node_id=?", int64(amount), taskID, nodeID)
		if executionID != "" {
			g5Exec(k.Db, "UPDATE kernel_executions SET token_reservation=0 WHERE id=?", executionID)
		}
		return nil
	})
}

// PauseNode holds a node without dropping its queue.
func (k *KernelStore) PauseNode(taskID, nodeID string) {
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=1 WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.paused", map[string]any{"nodeId": nodeID})
}

// ResumeNode clears a node pause.
func (k *KernelStore) ResumeNode(taskID, nodeID string) {
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.resumed", map[string]any{"nodeId": nodeID})
}

// ProviderCalls lists actual sends for a graph, optionally one node.
func (k *KernelStore) ProviderCalls(taskID string, nodeID ...string) []KernelProviderCall {
	query := "SELECT id,node_id,execution_id,reserved,state,usage,model,purpose,cost,created_at,settled_at FROM kernel_provider_calls WHERE task_id=?"
	args := []any{taskID}
	if len(nodeID) > 0 && nodeID[0] != "" {
		query += " AND node_id=?"
		args = append(args, nodeID[0])
	}
	query += " ORDER BY rowid"
	rows := g5Query(k.Db, query, args...)
	out := make([]KernelProviderCall, 0, len(rows))
	for _, row := range rows {
		call := KernelProviderCall{
			Id: g5Str(row["id"]), NodeId: g5Str(row["node_id"]), ExecutionId: g5Str(row["execution_id"]),
			Reserved: g5Int(row["reserved"]), State: g5Str(row["state"]), Purpose: g5Str(row["purpose"]), CreatedAt: g5Int(row["created_at"]),
		}
		if row["usage"] != nil {
			usage := &TokenUsage{}
			if err := json.Unmarshal([]byte(g5Str(row["usage"])), usage); err != nil {
				panic(err)
			}
			call.Usage = usage
		}
		if row["model"] != nil {
			model := &providerCallModel{}
			if err := json.Unmarshal([]byte(g5Str(row["model"])), model); err != nil {
				panic(err)
			}
			call.Model = model
		}
		if row["cost"] != nil {
			call.Cost = g5JSON(row["cost"])
		}
		if row["settled_at"] != nil {
			value := g5Int(row["settled_at"])
			call.SettledAt = &value
		}
		out = append(out, call)
	}
	return out
}

// ListNodes lists admitted nodes of the latest revision.
func (k *KernelStore) ListNodes(taskID string) []KernelNodeView {
	revision := k.LatestRevision(taskID)
	if revision == nil {
		return []KernelNodeView{}
	}
	rows := g5Query(k.Db, "SELECT node_id,instance_id,kind,status,revision_version FROM kernel_nodes WHERE task_id=? AND revision_version=? ORDER BY node_id", taskID, revision.Version)
	out := make([]KernelNodeView, 0, len(rows))
	for _, row := range rows {
		out = append(out, KernelNodeView{NodeId: g5Str(row["node_id"]), InstanceId: g5Str(row["instance_id"]), Kind: g5Str(row["kind"]), Status: g5Str(row["status"]), RevisionVersion: int(g5Int(row["revision_version"]))})
	}
	return out
}

// NodeStatus is the kernel status, or idle when the node has no row.
func (k *KernelStore) NodeStatus(taskID, nodeID string) string {
	row, ok := g5One(k.Db, "SELECT status FROM kernel_nodes WHERE task_id=? AND node_id=?", taskID, nodeID)
	if !ok {
		return "idle"
	}
	return g5Str(row["status"])
}

func (k *KernelStore) blockedWake(taskID, nodeID, reason string) {
	row, ok := g5One(k.Db, "SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1", taskID, nodeID)
	wake := BlockedNodeWake{NodeID: nodeID, Reason: reason}
	if ok {
		wake.IncidentID = g5Str(row["id"])
		wake.HasIncident = true
	}
	WakeForBlockedNode(k.Store, taskID, wake)
}

// FailNode records a terminal failure and wakes the master.
func (k *KernelStore) FailNode(taskID, nodeID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='failed' WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.failed", map[string]any{"nodeId": nodeID, "reason": reason})
	k.blockedWake(taskID, nodeID, reason)
}

// NoteQueueFailure keeps a failure reason on the queue row.
func (k *KernelStore) NoteQueueFailure(taskID string, seq int64, reason string) {
	g5Exec(k.Db, "UPDATE kernel_queue SET reason=? WHERE task_id=? AND seq=?", reason, taskID, seq)
}

// CompleteNode marks a node succeeded.
func (k *KernelStore) CompleteNode(taskID, nodeID string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='succeeded' WHERE task_id=? AND node_id=?", taskID, nodeID)
}

// ReconcileNodeUsage records or releases a held reservation and frees a blocked node.
func (k *KernelStore) ReconcileNodeUsage(taskID, nodeID, decision string) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		row, _ := g5One(k.Db, "SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?", taskID, nodeID)
		if decision == "record" {
			g5Exec(k.Db, "UPDATE kernel_node_state SET used=used+reserved,reserved=0,last_committed=used+reserved WHERE task_id=? AND node_id=?", taskID, nodeID)
		} else {
			g5Exec(k.Db, "UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?", taskID, nodeID)
		}
		g5Exec(k.Db, "UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'", taskID, nodeID)
		k.Store.Event(taskID, "graph.node.usage-reconciled", map[string]any{"nodeId": nodeID, "decision": decision, "held": g5Int(row["reserved"])})
		return nil
	})
}

// BlockNode parks a node without counting a failed attempt.
func (k *KernelStore) BlockNode(taskID, nodeID, reason string) {
	g5Exec(k.Db, "UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?", taskID, nodeID)
	k.Store.Event(taskID, "graph.node.blocked", map[string]any{"nodeId": nodeID, "reason": reason})
	k.blockedWake(taskID, nodeID, reason)
}

// RequestBudget opens one user budget question for a finite execution.
func (k *KernelStore) RequestBudget(taskID, nodeID, executionID, reason string) {
	execution := k.Execution(executionID)
	if execution == nil || execution.TaskId != taskID || execution.NodeId != nodeID || execution.TokenBudget == nil || execution.TokenBudget.Unlimited {
		return
	}
	k.Store.Transaction(func() any {
		if _, exists := g5One(k.Db, "SELECT 1 FROM questions WHERE task_id=? AND node_id=? AND kind='budget' AND status='open'", taskID, nodeID); exists {
			return nil
		}
		state := k.BudgetState(taskID, nodeID, *execution.TokenBudget)
		InsertQuestion(k.Store, QuestionInput{TaskId: taskID, NodeId: nodeID, Kind: "budget", Data: map[string]any{
			"prompt":      "Token quota is insufficient. Authorize an increment; main can then explicitly retry unsubmitted work.",
			"executionId": executionID, "reason": reason, "budget": state.Budget, "used": state.Used, "reserved": state.Reserved,
		}})
		return nil
	})
}

// CommitNodeUsage stores a reported total when it is a new safe integer.
func (k *KernelStore) CommitNodeUsage(taskID, nodeID string, total float64) {
	if !isSafeInteger(total) || total < 0 {
		return
	}
	k.ensureNodeState(taskID, nodeID)
	g5Exec(k.Db, "UPDATE kernel_node_state SET used=?,last_committed=? WHERE task_id=? AND node_id=?", int64(total), int64(total), taskID, nodeID)
}

func (k *KernelStore) ensureNodeState(taskID, nodeID string) {
	g5Exec(k.Db, "INSERT OR IGNORE INTO kernel_node_state(task_id,node_id) VALUES(?,?)", taskID, nodeID)
}

// NoteNodeAttempt counts one attempt.
func (k *KernelStore) NoteNodeAttempt(taskID, nodeID string) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET attempts=attempts+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

// NoteNodeResubmit counts one automatic resubmit when the allowance remains.
func (k *KernelStore) NoteNodeResubmit(taskID, nodeID string, allowed int) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		used := k.NodeState(taskID, nodeID).ResubmitsUsed
		if used >= allowed {
			Raise("invalid_queue", "Node "+nodeID+" already used its "+kernelItoa(int64(allowed))+" auto-resubmit(s)")
		}
		g5Exec(k.Db, "UPDATE kernel_node_state SET resubmits_used=resubmits_used+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

// SetNodeQueuePaused pauses or resumes one node's queue.
func (k *KernelStore) SetNodeQueuePaused(taskID, nodeID string, paused bool) {
	k.ModuleTransaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		flag := 0
		if paused {
			flag = 1
		}
		g5Exec(k.Db, "UPDATE kernel_node_state SET paused=? WHERE task_id=? AND node_id=?", flag, taskID, nodeID)
		if !paused {
			SetNativePause(k.Store, taskID, false, nodeID, 0)
		}
		return nil
	})
}

// ConfigureNodeRetries overrides the graph default for one node.
func (k *KernelStore) ConfigureNodeRetries(taskID, nodeID string, config NodeRetryConfig) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		if config.RetriesAllowed != nil {
			g5Exec(k.Db, "UPDATE kernel_node_state SET retries_allowed=? WHERE task_id=? AND node_id=?", *config.RetriesAllowed, taskID, nodeID)
		}
		if config.ResubmitsAllowed != nil {
			g5Exec(k.Db, "UPDATE kernel_node_state SET resubmits_allowed=? WHERE task_id=? AND node_id=?", *config.ResubmitsAllowed, taskID, nodeID)
		}
		return nil
	})
}

// NoteNodeRebind counts a session rebind.
func (k *KernelStore) NoteNodeRebind(taskID, nodeID string) {
	k.Store.Transaction(func() any {
		k.ensureNodeState(taskID, nodeID)
		g5Exec(k.Db, "UPDATE kernel_node_state SET rebinds=rebinds+1 WHERE task_id=? AND node_id=?", taskID, nodeID)
		return nil
	})
}

// ModuleInput reads one module input.
func (k *KernelStore) ModuleInput(taskID, moduleID, name string) *ModuleInputRow {
	row, ok := g5One(k.Db, "SELECT * FROM kernel_module_inputs WHERE task_id=? AND module_id=? AND name=?", taskID, moduleID, name)
	if !ok {
		return nil
	}
	var value any
	if row["value"] != nil {
		value = k.Content.Decode(g5Str(row["value"]))
	}
	var source *string
	if row["source"] != nil {
		text := g5Str(row["source"])
		source = &text
	}
	return &ModuleInputRow{ModuleId: moduleID, Name: g5Str(row["name"]), Delivered: g5Int(row["delivered"]) == 1, Value: value, Source: source, UpdatedAt: g5Int(row["updated_at"])}
}

// SetModuleInput records the latest accepted delivery for one input.
func (k *KernelStore) SetModuleInput(taskID, moduleID, name string, value any, source *string) {
	k.ModuleTransaction(func() any {
		k.setModuleInputInTransaction(taskID, moduleID, name, value, source)
		return nil
	})
}

func (k *KernelStore) setModuleInputInTransaction(taskID, moduleID, name string, value any, source *string) {
	var stored any
	if source != nil {
		stored = *source
	}
	g5Exec(k.Db, `INSERT INTO kernel_module_inputs(task_id,module_id,name,delivered,value,source,updated_at) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(task_id,module_id,name) DO UPDATE SET delivered=1, value=excluded.value, source=excluded.source, updated_at=excluded.updated_at`, taskID, moduleID, name, k.Content.Encode(value), stored, NowMillis())
}

// RecordModuleTransition stores one judgment and its outbox row.
func (k *KernelStore) RecordModuleTransition(taskID string, input ModuleTransitionInput) ModuleTransitionRow {
	id := graphUUID()
	createdAt := NowMillis()
	k.ModuleTransaction(func() any {
		var verdict any
		if input.Verdict != nil {
			verdict = *input.Verdict
		}
		g5Exec(k.Db, "INSERT INTO kernel_module_transitions(id,task_id,module_id,input_name,input_value,state_before,state_after,verdict,outputs,rule_version,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)", id, taskID, input.ModuleId, input.InputName, k.Content.Encode(input.InputValue), k.Content.Encode(input.StateBefore), k.Content.Encode(input.StateAfter), verdict, k.Content.Encode(input.Outputs), input.RuleVersion, input.Reason, createdAt)
		routed := 0
		if len(input.Outputs) == 0 {
			routed = 1
		}
		g5Exec(k.Db, "INSERT INTO kernel_transition_outbox(transition_id,routed) VALUES(?,?)", id, routed)
		triggered := 0
		if input.Verdict != nil {
			triggered = 1
		}
		g5Exec(k.Db, "UPDATE kernel_modules SET state=?, rule_version=?, triggered=CASE WHEN ?=1 THEN 1 ELSE triggered END WHERE task_id=? AND module_id=?", k.Content.Encode(input.StateAfter), input.RuleVersion, triggered, taskID, input.ModuleId)
		return nil
	})
	return ModuleTransitionRow{ModuleTransitionInput: input, Id: id, CreatedAt: createdAt}
}

// ModuleTransitions lists judgments in creation order.
func (k *KernelStore) ModuleTransitions(taskID, moduleID string) []ModuleTransitionRow {
	rows := g5Query(k.Db, "SELECT * FROM kernel_module_transitions WHERE task_id=? AND module_id=? ORDER BY created_at", taskID, moduleID)
	out := make([]ModuleTransitionRow, 0, len(rows))
	for _, row := range rows {
		var verdict *string
		if row["verdict"] != nil {
			text := g5Str(row["verdict"])
			verdict = &text
		}
		outputs, _ := k.Content.Decode(g5Str(row["outputs"])).(map[string]any)
		if outputs == nil {
			outputs = map[string]any{}
		}
		out = append(out, ModuleTransitionRow{
			Id: g5Str(row["id"]), CreatedAt: g5Int(row["created_at"]),
			ModuleTransitionInput: ModuleTransitionInput{
				ModuleId: moduleID, InputName: g5Str(row["input_name"]), InputValue: k.Content.Decode(g5Str(row["input_value"])),
				StateBefore: k.Content.Decode(g5Str(row["state_before"])), StateAfter: k.Content.Decode(g5Str(row["state_after"])),
				Verdict: verdict, Outputs: outputs, RuleVersion: int(g5Int(row["rule_version"])), Reason: g5Str(row["reason"]),
			},
		})
	}
	return out
}

func kernelOptInt(value any) *int {
	if value == nil {
		return nil
	}
	number := int(g5Int(value))
	return &number
}

func kernelItoa(value int64) string {
	if value == 0 {
		return "0"
	}
	negative := value < 0
	if negative {
		value = -value
	}
	digits := []byte{}
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	if negative {
		return "-" + string(digits)
	}
	return string(digits)
}

func kernelSplitEndpoint(endpoint string) (string, string) {
	dot := strings.IndexByte(endpoint, '.')
	if dot < 0 {
		if endpoint == "" {
			return "", ""
		}
		return endpoint[:len(endpoint)-1], endpoint
	}
	return endpoint[:dot], endpoint[dot+1:]
}

const kernelSchema = `
CREATE TABLE IF NOT EXISTS kernel_revisions(
  task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
  definition TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(task_id,version));
CREATE TABLE IF NOT EXISTS kernel_nodes(
  task_id TEXT NOT NULL REFERENCES tasks(id), revision_version INTEGER NOT NULL,
  node_id TEXT NOT NULL, instance_id TEXT NOT NULL, kind TEXT NOT NULL,
  spec TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'idle',
  PRIMARY KEY(task_id,node_id));
CREATE TABLE IF NOT EXISTS kernel_modules(
  task_id TEXT NOT NULL REFERENCES tasks(id), revision_version INTEGER NOT NULL,
  module_id TEXT NOT NULL, module_type TEXT NOT NULL, trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle', state TEXT NOT NULL DEFAULT 'null',
  rule_version INTEGER NOT NULL DEFAULT 1, triggered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id,module_id));
CREATE TABLE IF NOT EXISTS kernel_module_inputs(
  task_id TEXT NOT NULL REFERENCES tasks(id), module_id TEXT NOT NULL, name TEXT NOT NULL,
  delivered INTEGER NOT NULL DEFAULT 0, value TEXT, source TEXT, updated_at INTEGER NOT NULL,
  PRIMARY KEY(task_id,module_id,name));
CREATE TABLE IF NOT EXISTS kernel_executions(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL,
  revision_version INTEGER NOT NULL, attempt INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL, submission_id TEXT, missing_required INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS kernel_submissions(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  execution_id TEXT NOT NULL UNIQUE, content_digest TEXT NOT NULL, outputs TEXT NOT NULL,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kernel_deliveries(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
  submission_id TEXT REFERENCES kernel_submissions(id), edge_id TEXT,
  from_endpoint TEXT NOT NULL, to_endpoint TEXT NOT NULL, value TEXT NOT NULL,
  protocol TEXT NOT NULL, revision_version INTEGER NOT NULL, seq INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'accepted', created_at INTEGER NOT NULL,
  UNIQUE(submission_id, edge_id, to_endpoint));
CREATE TABLE IF NOT EXISTS kernel_module_transitions(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), module_id TEXT NOT NULL,
  input_name TEXT NOT NULL, input_value TEXT NOT NULL, state_before TEXT NOT NULL,
  state_after TEXT NOT NULL, verdict TEXT, outputs TEXT NOT NULL,
  rule_version INTEGER NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kernel_module_operations(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, module_id TEXT NOT NULL, delivery_id TEXT NOT NULL UNIQUE,
  revision_version INTEGER NOT NULL, request TEXT NOT NULL, state TEXT NOT NULL,
  result TEXT, error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
CREATE TABLE IF NOT EXISTS kernel_provider_calls(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, node_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  reserved INTEGER NOT NULL, state TEXT NOT NULL, usage TEXT, created_at INTEGER NOT NULL, settled_at INTEGER);
CREATE TABLE IF NOT EXISTS kernel_prompts(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, node_id TEXT NOT NULL,
  execution_id TEXT, system_prompt TEXT NOT NULL, tools TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kernel_node_bindings(
  task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL, model_id TEXT,
  system_prompt TEXT NOT NULL, tools TEXT NOT NULL, state_dir TEXT NOT NULL,
  PRIMARY KEY(task_id,node_id));
CREATE TABLE IF NOT EXISTS kernel_create_requests(
  owner_task_id TEXT NOT NULL, request_id TEXT NOT NULL, graph_id TEXT NOT NULL, content TEXT NOT NULL,
  state TEXT NOT NULL, error TEXT, PRIMARY KEY(owner_task_id,request_id));
CREATE TABLE IF NOT EXISTS kernel_graph_owners(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), owner_task_id TEXT NOT NULL REFERENCES tasks(id));
CREATE TABLE IF NOT EXISTS kernel_graph_layouts(
  task_id TEXT NOT NULL REFERENCES tasks(id), revision_version INTEGER NOT NULL,
  topology TEXT NOT NULL, layout TEXT NOT NULL, PRIMARY KEY(task_id,revision_version));
CREATE TABLE IF NOT EXISTS kernel_lifecycle(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), completion_requested INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kernel_completion_delivery(
  task_id TEXT PRIMARY KEY REFERENCES tasks(id), commit_sha TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kernel_graph_results(
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), output_name TEXT NOT NULL,
  source_id TEXT NOT NULL, value TEXT NOT NULL, protocol TEXT NOT NULL, revision_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, UNIQUE(task_id,output_name,source_id));
CREATE TABLE IF NOT EXISTS kernel_module_inbox(
  delivery_id TEXT PRIMARY KEY REFERENCES kernel_deliveries(id), task_id TEXT NOT NULL,
  module_id TEXT NOT NULL, processed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kernel_transition_outbox(
  transition_id TEXT PRIMARY KEY REFERENCES kernel_module_transitions(id), routed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS kernel_queue(
  seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
  node_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'queued', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS kernel_node_state(
  task_id TEXT NOT NULL REFERENCES tasks(id), node_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, resubmits_used INTEGER NOT NULL DEFAULT 0,
  retries_allowed INTEGER, resubmits_allowed INTEGER,
  paused INTEGER NOT NULL DEFAULT 0, rebinds INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id,node_id));
CREATE INDEX IF NOT EXISTS kernel_module_transitions_history ON kernel_module_transitions(task_id,module_id);
CREATE INDEX IF NOT EXISTS kernel_deliveries_execution ON kernel_deliveries(submission_id);
CREATE INDEX IF NOT EXISTS kernel_deliveries_to ON kernel_deliveries(task_id,to_endpoint);
CREATE INDEX IF NOT EXISTS kernel_queue_node ON kernel_queue(task_id,node_id,state);
CREATE INDEX IF NOT EXISTS kernel_executions_node ON kernel_executions(task_id,node_id);
CREATE INDEX IF NOT EXISTS kernel_transitions_module ON kernel_module_transitions(task_id,module_id)
`
