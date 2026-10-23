package graph

import (
	"database/sql"
	"strings"
)

// TokenBudget is the frozen quota of one node execution.
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
