import { wakeMaster, wakeForBlockedNode } from './wake-ledger.ts';
import { randomUUID } from 'node:crypto';
import type { TaskStore } from './store.ts';
import { canonicalJson } from './store.ts';
import { RuntimeError, type Json } from './types.ts';
import {
  parseGraphDefinition, validateProtocolValue, type GraphDefinition, type ProtocolSpec,
} from './interface-spec.ts';

/**
 * Graph v2 kernel durable layer (Issue #1 §3, §6, §13.2).
 *
 * Section 6 makes `submit` ONE short transaction: it checks execution eligibility,
 * the single-valid-submit rule, every enabled target's protocol, freezes the
 * connection revision, and writes the Submission, all Deliveries, the queue and the
 * events — all of it or none of it. Nothing here runs a model, module code or an
 * external command inside the transaction.
 *
 * Reused, not duplicated (Issue #1 §11): this store runs on the SAME SQLite
 * database as `TaskStore`, so WAL, canonical JSON, migrations and the running
 * kernel share one file. The v2 tables are additive and versioned.
 */

export interface RevisionRow {
  taskId: string;
  version: number;
  definition: GraphDefinition;
  reason: string;
  createdAt: number;
}

export interface DeliveryRow {
  id: string;
  taskId: string;
  /** Null when the delivery came from a module's emit rather than a node submission (§3). */
  submissionId: string | null;
  edgeId: string | null;
  fromEndpoint: string;
  toEndpoint: string;
  value: Json;
  protocol: string;
  revisionVersion: number;
  seq: number;
  state: 'accepted';
  /** Where this delivery came from: a node's submission, or a module's judgment. */
  source: 'submission' | 'module' | 'direct';
  createdAt: number;
}

export interface ExecutionRow {
  id: string;
  taskId: string;
  nodeId: string;
  revisionVersion: number;
  attempt: number;
  retriesUsed: number;
  resubmitsUsed: number;
  pendingGap: string[];
  state: string;
  submissionId: string | null;
  missingRequired: boolean;
  startedAt: number;
  endedAt: number | null;
}

export interface SubmitOutput {
  enable: boolean;
  value?: Json;
}

export interface SubmitRequest {
  outputs: Record<string, SubmitOutput>;
  /** Receipt identity for replay detection. */
  submissionId: string;
}

export interface SubmitReceipt {
  submissionId: string;
  replayed: boolean;
  deliveries: DeliveryRow[];
  /** True when the submission had no enabled recipients (§6). */
  noRecipients: boolean;
}

/** The stored shape of a delivery row, shared by the read paths. */
interface DeliveryRowDb {
  id: string; task_id: string; submission_id: string | null; edge_id: string | null; from_endpoint: string;
  to_endpoint: string; value: string; protocol: string; revision_version: number; seq: number; state: string;
  created_at: number; source?: string;
}

function deliveryRow(row: DeliveryRowDb): DeliveryRow {
  return {
    id: row.id, taskId: row.task_id, submissionId: row.submission_id, edgeId: row.edge_id,
    fromEndpoint: row.from_endpoint, toEndpoint: row.to_endpoint, value: json<Json>(row.value),
    protocol: row.protocol, revisionVersion: row.revision_version, seq: row.seq,
    state: 'accepted' as const,
    source: row.source === 'direct' ? 'direct' as const : row.source === 'module' ? 'module' as const : 'submission' as const,
    createdAt: row.created_at,
  };
}

export interface QueueRow {
  seq: number;
  taskId: string;
  nodeId: string;
  kind: string;
  payload: Json;
  generation?: number;
  state: 'queued' | 'claimed' | 'done' | 'failed';
  createdAt: number;
}

export interface NodeStateRow {
  attempts: number;
  resubmitsUsed: number;
  retriesAllowed: number | null;
  resubmitsAllowed: number | null;
  paused: boolean;
  rebinds: number;
}

interface QueueRowDb {
  seq: number; task_id: string; node_id: string; kind: string; payload: string; state: string; created_at: number;
}

const queueRow = (row: QueueRowDb): QueueRow => ({
  seq: row.seq, taskId: row.task_id, nodeId: row.node_id, kind: row.kind,
  payload: json<Json>(row.payload), state: row.state as QueueRow['state'], createdAt: row.created_at,
});

export interface ModuleInputRow {
  moduleId: string;
  name: string;
  delivered: boolean;
  value: Json;
  source: string | null;
  updatedAt: number;
}

export interface ModuleTransitionRow {
  id: string;
  moduleId: string;
  inputName: string;
  inputValue: Json;
  stateBefore: Json;
  stateAfter: Json;
  verdict: string | null;
  outputs: Record<string, Json>;
  ruleVersion: number;
  reason: string;
  createdAt: number;
}

const isRecord = (value: unknown): value is Record<string, Json> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const json = <T,>(text: string): T => JSON.parse(text) as T;

/**
 * The new kernel's storage, layered on the running `TaskStore` database.
 * Every method is a deliberate, small transaction; nothing here starts work.
 */
export class KernelStore {
  /** The running database, shared with TaskStore so the kernel does not get a second file. */
  get db() { return this.store.db; }

  /** The task store this kernel shares a database file with. */
  readonly store: TaskStore;

  constructor(store: TaskStore) {
    this.store = store;
    store.db.exec(`
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
      CREATE TABLE IF NOT EXISTS kernel_lifecycle(
        task_id TEXT PRIMARY KEY REFERENCES tasks(id), completion_requested INTEGER NOT NULL DEFAULT 0);
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
      CREATE INDEX IF NOT EXISTS kernel_deliveries_execution ON kernel_deliveries(submission_id);
      CREATE INDEX IF NOT EXISTS kernel_deliveries_to ON kernel_deliveries(task_id,to_endpoint);
      CREATE INDEX IF NOT EXISTS kernel_queue_node ON kernel_queue(task_id,node_id,state);
      CREATE INDEX IF NOT EXISTS kernel_executions_node ON kernel_executions(task_id,node_id);
      CREATE INDEX IF NOT EXISTS kernel_transitions_module ON kernel_module_transitions(task_id,module_id);
    `);
    // §3: a Delivery carries an edge id OR a direct source. A module's emit is not a
    // submission, so the column becomes nullable and a `source` tells the two apart.
    // Existing databases are migrated in place rather than reset.
    const executionColumns = new Set((this.db.prepare('PRAGMA table_info(kernel_executions)').all() as { name: string }[]).map(row => row.name));
    for (const [name, declaration] of [['waiting_slot', 'INTEGER NOT NULL DEFAULT 0'], ['retries_used', 'INTEGER NOT NULL DEFAULT 0'], ['resubmits_used', 'INTEGER NOT NULL DEFAULT 0'], ['pending_gap', "TEXT NOT NULL DEFAULT '[]'"]] as const) {
      if (!executionColumns.has(name)) this.db.exec(`ALTER TABLE kernel_executions ADD COLUMN ${name} ${declaration}`);
    }
    const deliveryColumns = new Set(
      (this.store.db.prepare('PRAGMA table_info(kernel_deliveries)').all() as { name: string }[]).map(column => column.name),
    );
    if (!deliveryColumns.has('source')) {
      this.store.db.exec("ALTER TABLE kernel_deliveries ADD COLUMN source TEXT NOT NULL DEFAULT 'submission'");
    }
    // §9 metering for v2 nodes. The old executor meters through `instances`, whose foreign
    // key points at `nodes(task_id,id)` - a table a v2 node deliberately has no row in, so a
    // v2 node could not be metered at all. The ledger therefore lives on the kernel's own
    // node state, keyed by the instance the node was admitted with.
    // A queue row that says `failed` without saying why is a dead end: the reason was
    // carried in memory and dropped, so a failure could not be read back after a restart.
    const queueColumns = new Set(
      (this.store.db.prepare('PRAGMA table_info(kernel_queue)').all() as { name: string }[]).map(column => column.name),
    );
    if (!queueColumns.has('reason')) {
      this.store.db.exec('ALTER TABLE kernel_queue ADD COLUMN reason TEXT');
    }
    if (!queueColumns.has('generation')) this.db.exec('ALTER TABLE kernel_queue ADD COLUMN generation INTEGER NOT NULL DEFAULT 0');
    const budgetColumns = new Set(
      (this.store.db.prepare('PRAGMA table_info(kernel_node_state)').all() as { name: string }[]).map(column => column.name),
    );
    for (const [column, ddl] of [
      ['used', 'ALTER TABLE kernel_node_state ADD COLUMN used INTEGER NOT NULL DEFAULT 0'],
      ['reserved', 'ALTER TABLE kernel_node_state ADD COLUMN reserved INTEGER NOT NULL DEFAULT 0'],
      ['last_committed', 'ALTER TABLE kernel_node_state ADD COLUMN last_committed INTEGER NOT NULL DEFAULT 0'],
    ] as const) {
      if (!budgetColumns.has(column)) this.store.db.exec(ddl);
    }
  }

  // ---- revisions (immutable) -------------------------------------------------

  /** §3/§8: publish an immutable revision. A version may never be overwritten. */
  publishRevision(taskId: string, input: { definition: GraphDefinition; reason: string; version?: number }): RevisionRow {
    if (!input.reason.trim()) throw new RuntimeError('invalid_definition', 'A revision reason is required');
    const definition = parseGraphDefinition(input.definition);
    return this.store.transaction(() => this.insertRevision(taskId, definition, input.reason, input.version));
  }

  /**
   * Insert a revision WITHOUT opening its own transaction, so a caller that must
   * write a graph and its first revision atomically (§5 whole-or-nothing) can do
   * both inside one transaction instead of nesting an illegal second BEGIN.
   */
  insertRevision(taskId: string, definition: GraphDefinition, reason: string, version?: number): RevisionRow {
    if (!reason.trim()) throw new RuntimeError('invalid_definition', 'A revision reason is required');
    const next = version ?? ((this.store.db.prepare('SELECT COALESCE(MAX(version),0) AS v FROM kernel_revisions WHERE task_id=?').get(taskId) as { v: number }).v + 1);
    const existing = this.store.db.prepare('SELECT 1 FROM kernel_revisions WHERE task_id=? AND version=?').get(taskId, next);
    if (existing) throw new RuntimeError('invalid_definition', `Revision ${next} already exists and is immutable`);
    const createdAt = Date.now();
    this.store.db.prepare('INSERT INTO kernel_revisions(task_id,version,definition,reason,created_at) VALUES(?,?,?,?,?)')
      .run(taskId, next, canonicalJson(definition), reason, createdAt);
    return { taskId, version: next, definition, reason, createdAt };
  }

  revision(taskId: string, version: number): RevisionRow | null {
    const row = this.store.db.prepare('SELECT * FROM kernel_revisions WHERE task_id=? AND version=?').get(taskId, version) as
      { definition: string; reason: string; created_at: number } | undefined;
    if (!row) return null;
    return { taskId, version, definition: json<GraphDefinition>(row.definition), reason: row.reason, createdAt: row.created_at };
  }

  latestRevision(taskId: string): RevisionRow | null {
    const row = this.store.db.prepare('SELECT version FROM kernel_revisions WHERE task_id=? ORDER BY version DESC LIMIT 1').get(taskId) as { version: number } | undefined;
    return row ? this.revision(taskId, row.version) : null;
  }

  private moduleTransactionActive = false;

  /** A synchronous module judgment and inbox acknowledgement share one commit. */
  moduleTransaction<T>(action: () => T): T {
    if (this.moduleTransactionActive) return action();
    return this.store.transaction(() => {
      this.moduleTransactionActive = true;
      try { return action(); } finally { this.moduleTransactionActive = false; }
    });
  }

  // ---- node / module admission ----------------------------------------------

  admitNode(taskId: string, revisionVersion: number, nodeId: string, input: { instanceId: string; kind?: string }): void {
    const revision = this.revision(taskId, revisionVersion);
    if (!revision) throw new RuntimeError('invalid_definition', `Unknown revision ${revisionVersion}`);
    const node = revision.definition.nodes[nodeId];
    if (!node) throw new RuntimeError('invalid_definition', `Revision ${revisionVersion} has no node ${nodeId}`);
    this.store.db.prepare('INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status) VALUES(?,?,?,?,?,?,?)')
      .run(taskId, revisionVersion, nodeId, input.instanceId, input.kind ?? 'agent', canonicalJson(node), 'idle');
  }

  admitModule(taskId: string, revisionVersion: number, moduleId: string, input: { moduleType: string; trigger: string }): void {
    const revision = this.revision(taskId, revisionVersion);
    if (!revision) throw new RuntimeError('invalid_definition', `Unknown revision ${revisionVersion}`);
    if (!revision.definition.modules[moduleId]) throw new RuntimeError('invalid_definition', `Revision ${revisionVersion} has no module ${moduleId}`);
    this.store.db.prepare('INSERT INTO kernel_modules(task_id,revision_version,module_id,module_type,trigger) VALUES(?,?,?,?,?)')
      .run(taskId, revisionVersion, moduleId, input.moduleType, input.trigger);
  }

  // ---- executions ------------------------------------------------------------

  startExecution(taskId: string, input: { executionId: string; nodeId: string; revisionVersion: number }): ExecutionRow {
    return this.store.transaction(() => {
      const existing = this.execution(input.executionId);
      if (existing) {
        if (existing.taskId !== taskId || existing.nodeId !== input.nodeId || existing.submissionId || existing.state !== 'blocked') {
          throw new RuntimeError('invalid_execution', 'Execution cannot be started again');
        }
        this.db.prepare("UPDATE kernel_executions SET state='running',ended_at=NULL WHERE id=?").run(input.executionId);
        return this.execution(input.executionId)!;
      }
      const startedAt = Date.now();
      this.store.db.prepare('INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at) VALUES(?,?,?,?,0,?,?)')
        .run(input.executionId, taskId, input.nodeId, input.revisionVersion, 'running', startedAt);
      return this.execution(input.executionId)!;
    });
  }

  /** Terminal execution state; the submission (if any) is already recorded. */
  /** Park a queued item without consuming it: the node can run again once unblocked. */
  blockQueued(taskId: string, seq: number): void {
    this.store.db.prepare("UPDATE kernel_queue SET state='queued' WHERE task_id=? AND seq=? AND state='claimed'").run(taskId, seq);
  }

  finishExecution(executionId: string, state: 'completed' | 'failed' | 'blocked'): void {
    this.store.db.prepare('UPDATE kernel_executions SET state=?, ended_at=? WHERE id=?').run(state, Date.now(), executionId);
  }

  execution(executionId: string): ExecutionRow | null {
    const row = this.store.db.prepare('SELECT * FROM kernel_executions WHERE id=?').get(executionId) as
      { id: string; task_id: string; node_id: string; revision_version: number; attempt: number; retries_used: number; resubmits_used: number; pending_gap: string; state: string; submission_id: string | null; missing_required: number; started_at: number; ended_at: number | null } | undefined;
    if (!row) return null;
    return {
      id: row.id, taskId: row.task_id, nodeId: row.node_id, revisionVersion: row.revision_version,
      attempt: row.attempt, retriesUsed: row.retries_used, resubmitsUsed: row.resubmits_used, pendingGap: json<string[]>(row.pending_gap), state: row.state, submissionId: row.submission_id,
      missingRequired: row.missing_required === 1, startedAt: row.started_at, endedAt: row.ended_at,
    };
  }

  /** Persist each continuation before sending it, so a restart cannot replenish its allowance. */
  noteExecutionContinuation(executionId: string, kind: 'retry' | 'resubmit', missing: string[] = []): void {
    const column = kind === 'retry' ? 'retries_used' : 'resubmits_used';
    this.db.prepare(`UPDATE kernel_executions SET ${column}=${column}+1,pending_gap=? WHERE id=?`).run(JSON.stringify(missing), executionId);
  }

  noteExecutionAttempt(executionId: string): number {
    this.db.prepare('UPDATE kernel_executions SET attempt=attempt+1 WHERE id=?').run(executionId);
    return this.execution(executionId)!.attempt;
  }

  // ---- submit (§6) -----------------------------------------------------------

  /**
   * One short transaction. Validates eligibility, the single-valid-submit rule and
   * every enabled target's protocol, freezes the connection revision, then writes
   * the Submission and all Deliveries. A bad target refuses the whole broadcast.
   */
  submit(executionId: string, request: SubmitRequest): SubmitReceipt {
    return this.store.transaction(() => {
      const execution = this.execution(executionId);
      if (!execution) throw new RuntimeError('invalid_submit', `Unknown execution ${executionId}`);
      // Dedup first, whatever the execution state: a submission already recorded
      // for this execution means this call is a replay or a second submit.
      const existing = this.store.db.prepare('SELECT id, content_digest FROM kernel_submissions WHERE execution_id=?').get(executionId) as
        { id: string; content_digest: string } | undefined;
      if (existing) return this.replayOrRefuse(execution, request, existing);
      if (execution.state !== 'running') {
        throw new RuntimeError('invalid_submit', `Execution ${execution.id} is ${execution.state} and has no submission to replay`);
      }
      const revision = this.revision(execution.taskId, execution.revisionVersion)!;
      const node = revision.definition.nodes[execution.nodeId];
      if (!node) throw new RuntimeError('invalid_submit', `Execution node ${execution.nodeId} is not in revision ${revision.version}`);

      // The output set is validated as a whole before anything is written.
      if (!request.outputs || typeof request.outputs !== 'object' || Array.isArray(request.outputs)) {
        throw new RuntimeError('invalid_submit', 'outputs must be a named object');
      }
      for (const [name, output] of Object.entries(request.outputs)) {
        const declared = node.outputs[name];
        if (!declared) throw new RuntimeError('invalid_submit', `Node ${execution.nodeId} has no output ${name}`);
        if (!output || typeof output !== 'object' || typeof output.enable !== 'boolean') throw new RuntimeError('invalid_submit', `Output ${name} requires a boolean enable`);
        if (output.enable !== true) continue;
        const spec = revision.definition.protocols[declared.protocol] as ProtocolSpec | undefined;
        if (!spec) throw new RuntimeError('invalid_submit', `Output ${name} references undeclared protocol ${declared.protocol}`);
        const defect = validateProtocolValue(spec, output.value ?? null, `${execution.nodeId}.${name}`);
        if (defect) throw new RuntimeError('invalid_submit', `Output ${name} does not satisfy ${declared.protocol}: ${defect}`);
      }
      // Required outputs must be enabled in this submission (§4).
      const queue = this.db.prepare("SELECT kind FROM kernel_queue WHERE task_id=? AND node_id=? AND state='claimed' LIMIT 1").get(execution.taskId, execution.nodeId) as { kind: string } | undefined;
      const enabled = Object.entries(request.outputs).filter(([, output]) => output.enable === true);
      const required = queue?.kind === 'chat' ? [] : node.submission.required ?? [];
      const anyOf = queue?.kind === 'chat' ? [] : node.submission.requiredAnyOf ?? [];
      if (anyOf.length && !anyOf.some(name => request.outputs[name]?.enable)) throw new RuntimeError('invalid_submit', `Required output(s) not enabled: ${anyOf.join(', ')}`);
      const missing = required.filter(name => !request.outputs[name]?.enable);
      if (missing.length) throw new RuntimeError('invalid_submit', `Required output(s) not enabled: ${missing.join(', ')}`);

      const connections = this.latestRevision(execution.taskId)!;

      // Collect every enabled connection from an enabled output, checking the
      // target's protocol (the receiving authority). One bad target refuses all.
      const targets: { edgeId: string; toEndpoint: string; value: Json; protocol: string }[] = [];
      for (const [name, output] of enabled) {
        for (const [edgeId, edge] of Object.entries(connections.definition.edges)) {
          if (edge.from !== `${execution.nodeId}.${name}` || edge.enabled !== true) continue;
          const owner = edge.to.slice(0, edge.to.indexOf('.'));
          const port = edge.to.slice(edge.to.indexOf('.') + 1);
          const targetNode = connections.definition.nodes[owner];
          const targetModule = connections.definition.modules[owner];
          const targetRef = targetNode?.inputs[port] ?? targetModule?.inputs[port];
          if (!targetRef) throw new RuntimeError('invalid_submit', `Edge ${edgeId} targets unknown input ${edge.to}`);
          const targetSpec = connections.definition.protocols[targetRef.protocol] as ProtocolSpec | undefined;
          if (targetSpec) {
            const defect = validateProtocolValue(targetSpec, output.value ?? null, edge.to);
            if (defect) throw new RuntimeError('invalid_submit', `Delivery ${edgeId} to ${edge.to} does not satisfy ${targetRef.protocol}: ${defect}`);
          }
          targets.push({ edgeId, toEndpoint: edge.to, value: output.value ?? null, protocol: targetRef.protocol });
        }
      }

      for (const [name, output] of enabled) this.publishGraphOutputs(execution.taskId, `${execution.nodeId}.${name}`, output.value ?? null, request.submissionId, connections);
      const contentDigest = canonicalJson({ outputs: request.outputs });
      const createdAt = Date.now();
      this.store.db.prepare('INSERT INTO kernel_submissions(id,task_id,execution_id,content_digest,outputs,created_at) VALUES(?,?,?,?,?,?)')
        .run(request.submissionId, execution.taskId, executionId, contentDigest, canonicalJson(request.outputs), createdAt);
      const deliveries: DeliveryRow[] = [];
      const nextSeq = ((this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?').get(execution.taskId) as { s: number }).s);
      for (const [index, target] of targets.entries()) {
        const id = randomUUID();
        const seq = nextSeq + index + 1;
        this.store.db.prepare('INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, execution.taskId, request.submissionId, target.edgeId, connections.definition.edges[target.edgeId]!.from, target.toEndpoint, canonicalJson(target.value), target.protocol, connections.version, seq, 'accepted', createdAt);
        // A module input keeps the latest accepted delivery (§2), and a delivery
        // to a node is queued in acceptance order (§7).
        const toOwner = target.toEndpoint.slice(0, target.toEndpoint.indexOf('.'));
        const toPort = target.toEndpoint.slice(target.toEndpoint.indexOf('.') + 1);
        if (connections.definition.modules[toOwner]) {
          this.db.prepare('INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)').run(id, execution.taskId, toOwner);
        } else {
          this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)')
            .run(execution.taskId, toOwner, 'delivery', canonicalJson({ deliveryId: id, input: toPort, value: target.value }), createdAt);
        }
        deliveries.push({
          id, taskId: execution.taskId, submissionId: request.submissionId, edgeId: target.edgeId,
          fromEndpoint: connections.definition.edges[target.edgeId]!.from, toEndpoint: target.toEndpoint, value: target.value,
          protocol: target.protocol, revisionVersion: connections.version, seq, state: 'accepted',
          source: 'submission' as const, createdAt,
        });
      }
      this.store.db.prepare('UPDATE kernel_executions SET submission_id=?, missing_required=0 WHERE id=?').run(request.submissionId, executionId);
      return { submissionId: request.submissionId, replayed: false, deliveries, noRecipients: deliveries.length === 0 && !this.db.prepare('SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1').get(execution.taskId, request.submissionId) };
    });
  }

  /** A second submit for one execution: an identical replay returns the receipt; anything else is refused. */
  private replayOrRefuse(execution: ExecutionRow, request: SubmitRequest, existing: { id: string; content_digest: string }): SubmitReceipt {
    const digest = canonicalJson({ outputs: request.outputs });
    if (existing.id === request.submissionId && existing.content_digest === digest) {
      const deliveries = this.deliveriesFor(execution.id);
      return { submissionId: request.submissionId, replayed: true, deliveries, noRecipients: deliveries.length === 0 && !this.db.prepare('SELECT 1 FROM kernel_graph_results WHERE task_id=? AND source_id=? LIMIT 1').get(execution.taskId, request.submissionId) };
    }
    throw new RuntimeError('invalid_submit', `Execution ${execution.id} already submitted; only one valid submission per execution is allowed`);
  }

  /** Accept a main-agent input and its landing in one transaction. */
  deliverDirect(taskId: string, endpoint: string, value: Json): { delivery: DeliveryRow; queue?: QueueRow } {
    const revision = this.latestRevision(taskId);
    if (!revision) throw new RuntimeError('invalid_graph', `Graph ${taskId} has no definition`);
    const dot = endpoint.indexOf('.');
    const owner = endpoint.slice(0, dot);
    const port = endpoint.slice(dot + 1);
    const ref = revision.definition.nodes[owner]?.inputs[port] ?? revision.definition.modules[owner]?.inputs[port];
    if (dot < 1 || !ref) throw new RuntimeError('invalid_input', `Unknown input ${endpoint}`);
    const defect = validateProtocolValue(revision.definition.protocols[ref.protocol]!, value, endpoint);
    if (defect) throw new RuntimeError('invalid_input', defect);
    return this.store.transaction(() => {
      const id = randomUUID();
      const createdAt = Date.now();
      const seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?').get(taskId) as { s: number }).s + 1;
      this.db.prepare('INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, null, null, 'main', endpoint, canonicalJson(value), ref.protocol, revision.version, seq, 'accepted', createdAt, 'direct');
      const delivery: DeliveryRow = { id, taskId, submissionId: null, edgeId: null, fromEndpoint: 'main', toEndpoint: endpoint,
        value, protocol: ref.protocol, revisionVersion: revision.version, seq, state: 'accepted', source: 'direct', createdAt };
      if (revision.definition.modules[owner]) {
        this.db.prepare('INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)').run(id, taskId, owner);
        this.store.event(taskId, 'graph.delivery.accepted', { deliveryId: id, endpoint });
        return { delivery };
      }
      const queue = this.enqueueInCurrentTransaction(taskId, { nodeId: owner, kind: 'delivery',
        payload: { deliveryId: id, input: port, value, protocol: ref.protocol, revisionVersion: revision.version } });
      return { delivery, queue };
    });
  }

  /** Every delivery accepted through one edge, newest first (§10 edge history). */
  deliveriesForEdge(taskId: string, edgeId: string): DeliveryRow[] {
    const rows = this.store.db.prepare(
      'SELECT * FROM kernel_deliveries WHERE task_id=? AND edge_id=? ORDER BY seq DESC')
      .all(taskId, edgeId) as unknown as DeliveryRowDb[];
    return rows.map(deliveryRow);
  }

  deliveriesFor(executionId: string): DeliveryRow[] {
    const rows = this.store.db.prepare(`
      SELECT d.* FROM kernel_deliveries d
      JOIN kernel_submissions s ON s.id = d.submission_id
      WHERE s.execution_id = ? ORDER BY d.seq`).all(executionId) as unknown as DeliveryRowDb[];
    return rows.map(deliveryRow);
  }

  /**
   * Land one delivery that a MODULE emitted, not a node submission (§2, §3, §6).
   * It carries no submissionId — §3 says a Delivery holds an edge id OR a direct
   * source — and writes the delivery with its landing.
   */
  recordModuleDelivery(taskId: string, input: {
    moduleId: string; edgeId: string; fromEndpoint: string; toEndpoint: string;
    value: Json; protocol: string; revisionVersion: number;
  }): DeliveryRow {
    return this.store.transaction(() => {
      const id = randomUUID();
      const createdAt = Date.now();
      const seq = ((this.store.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?').get(taskId) as { s: number }).s) + 1;
      this.store.db.prepare('INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, null, input.edgeId, input.fromEndpoint, input.toEndpoint, canonicalJson(input.value), input.protocol, input.revisionVersion, seq, 'accepted', createdAt, 'module');
      return {
        id, taskId, submissionId: null, edgeId: input.edgeId,
        fromEndpoint: input.fromEndpoint, toEndpoint: input.toEndpoint, value: input.value,
        protocol: input.protocol, revisionVersion: input.revisionVersion, seq,
        state: 'accepted' as const, source: 'module' as const, createdAt,
      };
    });
  }

  /** Public graph output is a durable business result, separate from runtime notices. */
  private publishGraphOutputs(taskId: string, endpoint: string, value: Json, sourceId: string, revision: RevisionRow): void {
    for (const [name, output] of Object.entries(revision.definition.outputs)) {
      if (output.from !== endpoint) continue;
      const resultId = randomUUID();
      const published = this.db.prepare('INSERT OR IGNORE INTO kernel_graph_results(id,task_id,output_name,source_id,value,protocol,revision_version,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(resultId, taskId, name, sourceId, canonicalJson(value), output.protocol, revision.version, Date.now());
      if (!published.changes) continue;
      wakeMaster(this.store, { taskId, kind: 'graph_output', dedupeKey: `${taskId}:${name}:${sourceId}`,
        data: { graphId: taskId, output: name, sourceId, resultId, revision: revision.version } });
      this.store.event(taskId, 'graph.output', { output: name, sourceId, value, revision: revision.version });
      if (revision.definition.completion?.on === name) {
        this.db.prepare('INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES(?,1) ON CONFLICT(task_id) DO UPDATE SET completion_requested=1').run(taskId);
        this.db.prepare("UPDATE tasks SET phase='completing' WHERE id=? AND phase NOT IN ('stopping','stopped','completed')").run(taskId);
      }
    }
  }

  /** Validate the whole module broadcast, then persist every landing together. */
  broadcastModule(taskId: string, moduleId: string, outputs: Record<string, Json>, transitionId?: string): DeliveryRow[] {
    return this.store.transaction(() => {
      if (transitionId && (this.db.prepare('SELECT routed FROM kernel_transition_outbox WHERE transition_id=?').get(transitionId) as { routed: number } | undefined)?.routed === 1) return [];
      const revision = this.latestRevision(taskId);
      const module = revision?.definition.modules[moduleId];
      if (!revision || !module) throw new RuntimeError('invalid_definition', `Unknown module ${moduleId}`);
      const targets: { edgeId: string; endpoint: string; protocol: string; value: Json; owner: string; port: string; module: boolean }[] = [];
      for (const [name, value] of Object.entries(outputs)) {
        const output = module.outputs[name];
        if (!output) throw new RuntimeError('invalid_output', `Unknown output ${moduleId}.${name}`);
        const protocol = revision.definition.protocols[output.protocol];
        if (!protocol) throw new RuntimeError('invalid_definition', `Unknown protocol ${output.protocol}`);
        const defect = validateProtocolValue(protocol, value, `${moduleId}.${name}`);
        if (defect) throw new RuntimeError('invalid_output', defect);
        for (const [edgeId, edge] of Object.entries(revision.definition.edges)) {
          if (edge.enabled === false || edge.from !== `${moduleId}.${name}`) continue;
          const dot = edge.to.indexOf('.');
          const owner = edge.to.slice(0, dot);
          const port = edge.to.slice(dot + 1);
          const targetModule = revision.definition.modules[owner];
          const input = (targetModule ?? revision.definition.nodes[owner])?.inputs[port];
          const targetProtocol = input && revision.definition.protocols[input.protocol];
          if (!input || !targetProtocol) throw new RuntimeError('invalid_definition', `Unknown input ${edge.to}`);
          const targetDefect = validateProtocolValue(targetProtocol, value, edge.to);
          if (targetDefect) throw new RuntimeError('invalid_output', targetDefect);
          targets.push({ edgeId, endpoint: edge.to, protocol: input.protocol, value, owner, port, module: !!targetModule });
        }
      }
      for (const [name, value] of Object.entries(outputs)) this.publishGraphOutputs(taskId, `${moduleId}.${name}`, value, transitionId ?? randomUUID(), revision);
      let seq = (this.db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM kernel_deliveries WHERE task_id=?').get(taskId) as { s: number }).s;
      const deliveries = targets.map(target => {
        const id = randomUUID();
        const createdAt = Date.now();
        seq += 1;
        const edge = revision.definition.edges[target.edgeId]!;
        this.db.prepare('INSERT INTO kernel_deliveries(id,task_id,submission_id,edge_id,from_endpoint,to_endpoint,value,protocol,revision_version,seq,state,created_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, taskId, null, target.edgeId, edge.from, target.endpoint, canonicalJson(target.value), target.protocol, revision.version, seq, 'accepted', createdAt, 'module');
        if (target.module) this.db.prepare('INSERT INTO kernel_module_inbox(delivery_id,task_id,module_id) VALUES(?,?,?)').run(id, taskId, target.owner);
        else this.enqueueDelivery(taskId, target.owner, { deliveryId: id, input: target.port, value: target.value });
        return { id, taskId, submissionId: null, edgeId: target.edgeId, fromEndpoint: edge.from,
          toEndpoint: target.endpoint, value: target.value, protocol: target.protocol,
          revisionVersion: revision.version, seq, state: 'accepted' as const, source: 'module' as const, createdAt };
      });
      if (transitionId) this.db.prepare('UPDATE kernel_transition_outbox SET routed=1 WHERE transition_id=?').run(transitionId);
      return deliveries;
    });
  }

  /** Queue a delivery for a node without a submission, in acceptance order (§7). */
  enqueueDelivery(taskId: string, nodeId: string, payload: Json): void {
    this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)')
      .run(taskId, nodeId, 'delivery', canonicalJson(payload), Date.now());
  }

  // ---- node queue and per-node retry state (§7) -------------------------------

  /** Append one input to a node's serial queue. Returns the accepted row. */
  /**
   * `enqueue` without its own transaction, for callers already inside one (materialisation
   * runs inside the confirmation's transaction; nesting a second BEGIN aborts it).
   */
  enqueueInCurrentTransaction(taskId: string, input: { nodeId: string; kind: string; payload: Json }): QueueRow {
    const createdAt = Date.now();
    const result = this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,state,created_at) VALUES(?,?,?,?,?,?)')
      .run(taskId, input.nodeId, input.kind, canonicalJson(input.payload), 'queued', createdAt);
    return { seq: Number(result.lastInsertRowid), taskId, nodeId: input.nodeId, kind: input.kind, payload: input.payload, state: 'queued' as const, createdAt };
  }

  enqueue(taskId: string, input: { nodeId: string; kind: string; payload: Json }): QueueRow {
    return this.store.transaction(() => {
      const createdAt = Date.now();
      const result = this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,state,created_at) VALUES(?,?,?,?,?,?)')
        .run(taskId, input.nodeId, input.kind, canonicalJson(input.payload), 'queued', createdAt);
      const seq = Number(result.lastInsertRowid);
      return { seq, taskId, nodeId: input.nodeId, kind: input.kind, payload: input.payload, state: 'queued' as const, createdAt };
    });
  }

  /** The oldest queued item for a node, or null when the node has nothing queued. */
  nextQueued(taskId: string, nodeId: string): QueueRow | null {
    const row = this.store.db.prepare("SELECT * FROM kernel_queue WHERE task_id=? AND node_id=? AND state='queued' ORDER BY seq LIMIT 1")
      .get(taskId, nodeId) as QueueRowDb | undefined;
    return row ? queueRow(row) : null;
  }

  /** Mark an item claimed; a claimed item is the node's one running execution. */
  claimQueued(taskId: string, seq: number): QueueRow {
    return this.store.transaction(() => {
      const row = this.store.db.prepare('SELECT * FROM kernel_queue WHERE task_id=? AND seq=?').get(taskId, seq) as QueueRowDb | undefined;
      if (!row) throw new RuntimeError('invalid_queue', `Unknown queue item ${seq}`);
      if (row.state !== 'queued') throw new RuntimeError('invalid_queue', `Queue item ${seq} is ${row.state}`);
      this.store.db.prepare("UPDATE kernel_queue SET state='claimed' WHERE task_id=? AND seq=?").run(taskId, seq);
      return { ...queueRow(row), state: 'claimed' };
    });
  }

  finishQueued(taskId: string, seq: number, state: 'done' | 'failed'): void {
    this.store.db.prepare('UPDATE kernel_queue SET state=? WHERE task_id=? AND seq=?').run(state, taskId, seq);
  }

  /** Per-node retry state, created on first read so a fresh node reports zeroes. */
  nodeState(taskId: string, nodeId: string): NodeStateRow {
    const row = this.store.db.prepare('SELECT * FROM kernel_node_state WHERE task_id=? AND node_id=?').get(taskId, nodeId) as
      { attempts: number; resubmits_used: number; retries_allowed: number | null; resubmits_allowed: number | null; paused: number; rebinds: number } | undefined;
    return row
      ? { attempts: row.attempts, resubmitsUsed: row.resubmits_used, retriesAllowed: row.retries_allowed, resubmitsAllowed: row.resubmits_allowed, paused: row.paused === 1, rebinds: row.rebinds }
      : { attempts: 0, resubmitsUsed: 0, retriesAllowed: null, resubmitsAllowed: null, paused: false, rebinds: 0 };
  }

  // ---- metering (v2) ---------------------------------------------------------

  /**
   * What a node has spent and what it currently holds.
   *
   * The budget itself is passed in rather than stored, because §9 gives it to the runtime
   * (limits, an explicit per-node override, or "unlimited") and the kernel only owns the
   * counters. `committedUsage` is separate from `used` so a re-reported total is recognised
   * as the same figure rather than charged twice - providers re-report a turn's usage.
   */
  budgetState(taskId: string, nodeId: string, budget: { budget: number; unlimited: boolean }): {
    budget: number; unlimited: boolean; used: number; reserved: number;
  } {
    this.ensureNodeState(taskId, nodeId);
    const row = this.store.db.prepare('SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?').get(taskId, nodeId) as
      { used: number; reserved: number };
    return { budget: budget.budget, unlimited: budget.unlimited, used: row.used, reserved: row.reserved };
  }

  /**
   * Hold `amount` for work about to start, refusing it when the node cannot afford it.
   *
   * The check and the write are one transaction: a refusal must not leave a partial hold,
   * because a node that silently reserved nothing would run unbudgeted.
   */
  reserveNodeTokens(taskId: string, nodeId: string, budget: { budget: number; unlimited: boolean }, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new RuntimeError('invalid_adapter', 'A bounded token reservation is required');
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      const row = this.store.db.prepare('SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?').get(taskId, nodeId) as
        { used: number; reserved: number };
      if (!budget.unlimited && row.used + row.reserved + amount > budget.budget) {
        throw new RuntimeError('budget', `Token budget exhausted for node ${nodeId}`);
      }
      this.store.db.prepare('UPDATE kernel_node_state SET reserved=reserved+? WHERE task_id=? AND node_id=?').run(amount, taskId, nodeId);
    });
  }

  releaseNodeTokens(taskId: string, nodeId: string, amount: number): void {
    if (!Number.isSafeInteger(amount) || amount < 0) return;
    this.ensureNodeState(taskId, nodeId);
    this.store.db.prepare('UPDATE kernel_node_state SET reserved=MAX(0,reserved-?) WHERE task_id=? AND node_id=?').run(amount, taskId, nodeId);
  }

  /**
   * Hold a node before its turn is sent.
   *
   * Pausing is not stopping: the node's queued work survives, so resuming lets it run with
   * nothing lost. The old executor makes the same distinction - a node paused before its
   * turn is never sent, while a turn already in flight drains rather than being torn down.
   */
  pauseNode(taskId: string, nodeId: string): void {
    this.ensureNodeState(taskId, nodeId);
    this.store.db.prepare('UPDATE kernel_node_state SET paused=1 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
    this.store.event(taskId, 'graph.node.paused', { nodeId });
  }

  resumeNode(taskId: string, nodeId: string): void {
    this.ensureNodeState(taskId, nodeId);
    this.store.db.prepare('UPDATE kernel_node_state SET paused=0 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
    this.store.event(taskId, 'graph.node.resumed', { nodeId });
  }

  /**
   * The graph's admitted nodes, for the newest revision.
   *
   * §13.7 needs this to show a user what a v2 graph is made of. A v2 task has no rows in
   * the old `nodes` table, so without this a user opening one saw only the master node and
   * no graph at all. It is also the only place a parked node's `blocked` status can be read
   * from: without it a node that stopped on an exhausted budget is indistinguishable from
   * one that was never scheduled.
   */
  listNodes(taskId: string): { nodeId: string; instanceId: string; kind: string; status: string; revisionVersion: number }[] {
    const revision = this.latestRevision(taskId);
    if (!revision) return [];
    const rows = this.store.db.prepare('SELECT node_id,instance_id,kind,status,revision_version FROM kernel_nodes WHERE task_id=? AND revision_version=? ORDER BY node_id')
      .all(taskId, revision.version) as { node_id: string; instance_id: string; kind: string; status: string; revision_version: number }[];
    return rows.map(row => ({ nodeId: row.node_id, instanceId: row.instance_id, kind: row.kind, status: row.status, revisionVersion: row.revision_version }));
  }

  /** A node's current state, as the kernel records it. */
  nodeStatus(taskId: string, nodeId: string): string {
    const row = this.store.db.prepare('SELECT status FROM kernel_nodes WHERE task_id=? AND node_id=?').get(taskId, nodeId) as { status: string } | undefined;
    return row?.status ?? 'idle';
  }

  /**
   * Record that a node failed, keeping the reason where it can be read back.
   *
   * HB-272 makes a failure something a person has to act on, and a failure nobody can read
   * is one nobody will. Both halves matter: the node's own status (so a graph view shows
   * what happened) and an event (so the reason is on the timeline, not only in a row).
   */
  failNode(taskId: string, nodeId: string, reason: string): void {
    this.store.db.prepare("UPDATE kernel_nodes SET status='failed' WHERE task_id=? AND node_id=?").run(taskId, nodeId);
    this.store.event(taskId, 'graph.node.failed', { nodeId, reason });
    const execution = this.db.prepare('SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1').get(taskId, nodeId) as { id: string } | undefined;
    wakeForBlockedNode(this.store, taskId, { nodeId, reason, ...(execution ? { incidentId: execution.id } : {}) });
  }

  /** Keep the reason on a queue row that just failed, so it survives a restart. */
  noteQueueFailure(taskId: string, seq: number, reason: string): void {
    this.store.db.prepare('UPDATE kernel_queue SET reason=? WHERE task_id=? AND seq=?').run(reason, taskId, seq);
  }

  /**
   * Record that a node finished its work.
   *
   * The executor owns when a node is done; the kernel is where that fact lives. Without it
   * a node that had succeeded still read `idle` in the view, and a graph that had finished
   * looked like it had never started.
   */
  completeNode(taskId: string, nodeId: string): void {
    this.store.db.prepare("UPDATE kernel_nodes SET status='succeeded' WHERE task_id=? AND node_id=?").run(taskId, nodeId);
  }

  /**
   * Resolve a hold taken because a turn reported no usage.
   *
   * `record` charges the hold as spent - the tokens are gone, we just cannot say how many.
   * `release` returns it, which is honest only when the send never happened. Either way the
   * node is freed, because a parked node is a question someone has to answer.
   */
  reconcileNodeUsage(taskId: string, nodeId: string, decision: 'record' | 'release'): void {
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      const row = this.store.db.prepare('SELECT used,reserved FROM kernel_node_state WHERE task_id=? AND node_id=?').get(taskId, nodeId) as
        { used: number; reserved: number };
      if (decision === 'record') {
        this.store.db.prepare('UPDATE kernel_node_state SET used=used+reserved,reserved=0,last_committed=used+reserved WHERE task_id=? AND node_id=?')
          .run(taskId, nodeId);
      } else {
        this.store.db.prepare('UPDATE kernel_node_state SET reserved=0 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
      }
      this.store.db.prepare("UPDATE kernel_nodes SET status='idle' WHERE task_id=? AND node_id=? AND status='blocked'").run(taskId, nodeId);
      this.store.event(taskId, 'graph.node.usage-reconciled', { nodeId, decision, held: row.reserved });
    });
  }

  /**
   * Park a node that cannot proceed, without recording it as a failed attempt.
   *
   * `blocked` is a state an operator or the user can resolve (raise the budget, answer a
   * question); `failed` is not. Marking an exhausted node `failed` would make a
   * recoverable condition look terminal.
   */
  blockNode(taskId: string, nodeId: string, reason: string): void {
    this.store.db.prepare("UPDATE kernel_nodes SET status='blocked' WHERE task_id=? AND node_id=?").run(taskId, nodeId);
    this.store.event(taskId, 'graph.node.blocked', { nodeId, reason });
    const execution = this.db.prepare('SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? ORDER BY rowid DESC LIMIT 1').get(taskId, nodeId) as { id: string } | undefined;
    wakeForBlockedNode(this.store, taskId, { nodeId, reason, ...(execution ? { incidentId: execution.id } : {}) });
  }

  /** Commit a reported total. A total at or below the last one is the same figure again. */
  commitNodeUsage(taskId: string, nodeId: string, total: number): void {
    if (!Number.isSafeInteger(total) || total < 0) return;
    this.ensureNodeState(taskId, nodeId);
    this.store.db.prepare('UPDATE kernel_node_state SET used=?,last_committed=? WHERE task_id=? AND node_id=?')
      .run(total, total, taskId, nodeId);
  }

  private ensureNodeState(taskId: string, nodeId: string): void {
    this.store.db.prepare('INSERT OR IGNORE INTO kernel_node_state(task_id,node_id) VALUES(?,?)').run(taskId, nodeId);
  }

  noteNodeAttempt(taskId: string, nodeId: string): void {
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      this.store.db.prepare('UPDATE kernel_node_state SET attempts=attempts+1 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
    });
  }

  noteNodeResubmit(taskId: string, nodeId: string, allowed: number): void {
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      const used = this.nodeState(taskId, nodeId).resubmitsUsed;
      if (used >= allowed) throw new RuntimeError('invalid_queue', `Node ${nodeId} already used its ${allowed} auto-resubmit(s)`);
      this.store.db.prepare('UPDATE kernel_node_state SET resubmits_used=resubmits_used+1 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
    });
  }

  setNodeQueuePaused(taskId: string, nodeId: string, paused: boolean): void {
    this.moduleTransaction(() => {
      this.ensureNodeState(taskId, nodeId);
      this.store.db.prepare('UPDATE kernel_node_state SET paused=? WHERE task_id=? AND node_id=?').run(paused ? 1 : 0, taskId, nodeId);
    });
  }

  configureNodeRetries(taskId: string, nodeId: string, config: { retriesAllowed?: number; resubmitsAllowed?: number }): void {
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      if (config.retriesAllowed !== undefined) this.store.db.prepare('UPDATE kernel_node_state SET retries_allowed=? WHERE task_id=? AND node_id=?').run(config.retriesAllowed, taskId, nodeId);
      if (config.resubmitsAllowed !== undefined) this.store.db.prepare('UPDATE kernel_node_state SET resubmits_allowed=? WHERE task_id=? AND node_id=?').run(config.resubmitsAllowed, taskId, nodeId);
    });
  }

  noteNodeRebind(taskId: string, nodeId: string): void {
    this.store.transaction(() => {
      this.ensureNodeState(taskId, nodeId);
      this.store.db.prepare('UPDATE kernel_node_state SET rebinds=rebinds+1 WHERE task_id=? AND node_id=?').run(taskId, nodeId);
    });
  }

  // ---- module inputs and transitions -----------------------------------------

  moduleInput(taskId: string, moduleId: string, name: string): ModuleInputRow | null {
    const row = this.store.db.prepare('SELECT * FROM kernel_module_inputs WHERE task_id=? AND module_id=? AND name=?').get(taskId, moduleId, name) as
      { name: string; delivered: number; value: string | null; source: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return { moduleId, name: row.name, delivered: row.delivered === 1, value: row.value === null ? null : json<Json>(row.value), source: row.source, updatedAt: row.updated_at };
  }

  /** Record the latest accepted delivery for a module input (§2). */
  setModuleInput(taskId: string, moduleId: string, name: string, value: Json, source: string | null = null): void {
    this.moduleTransaction(() => this.setModuleInputInTransaction(taskId, moduleId, name, value, source));
  }

  private setModuleInputInTransaction(taskId: string, moduleId: string, name: string, value: Json, source: string | null): void {
    this.store.db.prepare(`
      INSERT INTO kernel_module_inputs(task_id,module_id,name,delivered,value,source,updated_at) VALUES(?,?,?,1,?,?,?)
      ON CONFLICT(task_id,module_id,name) DO UPDATE SET delivered=1, value=excluded.value, source=excluded.source, updated_at=excluded.updated_at`)
      .run(taskId, moduleId, name, canonicalJson(value), source, Date.now());
  }

  recordModuleTransition(taskId: string, input: {
    moduleId: string; inputName: string; inputValue: Json; stateBefore: Json; stateAfter: Json;
    verdict: string | null; outputs: Record<string, Json>; ruleVersion: number; reason: string;
  }): ModuleTransitionRow {
    const id = randomUUID();
    const createdAt = Date.now();
    this.moduleTransaction(() => {
      this.store.db.prepare('INSERT INTO kernel_module_transitions(id,task_id,module_id,input_name,input_value,state_before,state_after,verdict,outputs,rule_version,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, input.moduleId, input.inputName, canonicalJson(input.inputValue), canonicalJson(input.stateBefore), canonicalJson(input.stateAfter), input.verdict, canonicalJson(input.outputs), input.ruleVersion, input.reason, createdAt);
      this.db.prepare('INSERT INTO kernel_transition_outbox(transition_id,routed) VALUES(?,?)').run(id, Object.keys(input.outputs).length ? 0 : 1);
      this.store.db.prepare('UPDATE kernel_modules SET state=?, rule_version=?, triggered=CASE WHEN ?=1 THEN 1 ELSE triggered END WHERE task_id=? AND module_id=?')
        .run(canonicalJson(input.stateAfter), input.ruleVersion, input.verdict === null ? 0 : 1, taskId, input.moduleId);
    });
    return { id, ...input, createdAt };
  }

  moduleTransitions(taskId: string, moduleId: string): ModuleTransitionRow[] {
    const rows = this.store.db.prepare('SELECT * FROM kernel_module_transitions WHERE task_id=? AND module_id=? ORDER BY created_at').all(taskId, moduleId) as {
      id: string; input_name: string; input_value: string; state_before: string; state_after: string;
      verdict: string | null; outputs: string; rule_version: number; reason: string; created_at: number;
    }[];
    return rows.map(row => ({
      id: row.id, moduleId, inputName: row.input_name, inputValue: json<Json>(row.input_value),
      stateBefore: json<Json>(row.state_before), stateAfter: json<Json>(row.state_after),
      verdict: row.verdict, outputs: json<Record<string, Json>>(row.outputs), ruleVersion: row.rule_version,
      reason: row.reason, createdAt: row.created_at,
    }));
  }
}
