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
  source: 'submission' | 'module';
  createdAt: number;
}

export interface ExecutionRow {
  id: string;
  taskId: string;
  nodeId: string;
  revisionVersion: number;
  attempt: number;
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
    source: row.source === 'module' ? 'module' as const : 'submission' as const,
    createdAt: row.created_at,
  };
}

export interface QueueRow {
  seq: number;
  taskId: string;
  nodeId: string;
  kind: string;
  payload: Json;
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

  constructor(readonly store: TaskStore) {
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
    const deliveryColumns = new Set(
      (this.store.db.prepare('PRAGMA table_info(kernel_deliveries)').all() as { name: string }[]).map(column => column.name),
    );
    if (!deliveryColumns.has('source')) {
      this.store.db.exec("ALTER TABLE kernel_deliveries ADD COLUMN source TEXT NOT NULL DEFAULT 'submission'");
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
      const startedAt = Date.now();
      this.store.db.prepare('INSERT INTO kernel_executions(id,task_id,node_id,revision_version,attempt,state,started_at) VALUES(?,?,?,?,1,?,?)')
        .run(input.executionId, taskId, input.nodeId, input.revisionVersion, 'running', startedAt);
      return this.execution(input.executionId)!;
    });
  }

  /** Terminal execution state; the submission (if any) is already recorded. */
  finishExecution(executionId: string, state: 'completed' | 'failed'): void {
    this.store.db.prepare('UPDATE kernel_executions SET state=?, ended_at=? WHERE id=?').run(state, Date.now(), executionId);
  }

  execution(executionId: string): ExecutionRow | null {
    const row = this.store.db.prepare('SELECT * FROM kernel_executions WHERE id=?').get(executionId) as
      { id: string; task_id: string; node_id: string; revision_version: number; attempt: number; state: string; submission_id: string | null; missing_required: number; started_at: number; ended_at: number | null } | undefined;
    if (!row) return null;
    return {
      id: row.id, taskId: row.task_id, nodeId: row.node_id, revisionVersion: row.revision_version,
      attempt: row.attempt, state: row.state, submissionId: row.submission_id,
      missingRequired: row.missing_required === 1, startedAt: row.started_at, endedAt: row.ended_at,
    };
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
      const enabled = Object.entries(request.outputs).filter(([, output]) => output.enable === true);
      for (const [name, output] of Object.entries(request.outputs)) {
        const declared = node.outputs[name];
        if (!declared) throw new RuntimeError('invalid_submit', `Node ${execution.nodeId} has no output ${name}`);
        if (output.enable !== true) continue;
        const spec = revision.definition.protocols[declared.protocol] as ProtocolSpec | undefined;
        if (!spec) throw new RuntimeError('invalid_submit', `Output ${name} references undeclared protocol ${declared.protocol}`);
        const defect = validateProtocolValue(spec, output.value ?? null, `${execution.nodeId}.${name}`);
        if (defect) throw new RuntimeError('invalid_submit', `Output ${name} does not satisfy ${declared.protocol}: ${defect}`);
      }
      // Required outputs must be enabled in this submission (§4).
      const required = node.submission.required ?? [];
      const missing = required.filter(name => !request.outputs[name]?.enable);
      if (missing.length) throw new RuntimeError('invalid_submit', `Required output(s) not enabled: ${missing.join(', ')}`);

      // Collect every enabled connection from an enabled output, checking the
      // target's protocol (the receiving authority). One bad target refuses all.
      const targets: { edgeId: string; toEndpoint: string; value: Json; protocol: string }[] = [];
      for (const [name, output] of enabled) {
        for (const [edgeId, edge] of Object.entries(revision.definition.edges)) {
          if (edge.from !== `${execution.nodeId}.${name}` || edge.enabled !== true) continue;
          const owner = edge.to.slice(0, edge.to.indexOf('.'));
          const port = edge.to.slice(edge.to.indexOf('.') + 1);
          const targetNode = revision.definition.nodes[owner];
          const targetModule = revision.definition.modules[owner];
          const targetRef = targetNode?.inputs[port] ?? targetModule?.inputs[port];
          if (!targetRef) throw new RuntimeError('invalid_submit', `Edge ${edgeId} targets unknown input ${edge.to}`);
          const targetSpec = revision.definition.protocols[targetRef.protocol] as ProtocolSpec | undefined;
          if (targetSpec) {
            const defect = validateProtocolValue(targetSpec, output.value ?? null, edge.to);
            if (defect) throw new RuntimeError('invalid_submit', `Delivery ${edgeId} to ${edge.to} does not satisfy ${targetRef.protocol}: ${defect}`);
          }
          targets.push({ edgeId, toEndpoint: edge.to, value: output.value ?? null, protocol: targetRef.protocol });
        }
      }

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
          .run(id, execution.taskId, request.submissionId, target.edgeId, `${execution.nodeId}`, target.toEndpoint, canonicalJson(target.value), target.protocol, revision.version, seq, 'accepted', createdAt);
        // A module input keeps the latest accepted delivery (§2), and a delivery
        // to a node is queued in acceptance order (§7).
        const toOwner = target.toEndpoint.slice(0, target.toEndpoint.indexOf('.'));
        const toPort = target.toEndpoint.slice(target.toEndpoint.indexOf('.') + 1);
        if (revision.definition.modules[toOwner]) {
          this.setModuleInputInTransaction(execution.taskId, toOwner, toPort, target.value, `delivery:${id}`);
        } else {
          this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)')
            .run(execution.taskId, toOwner, 'delivery', canonicalJson({ deliveryId: id, input: toPort, value: target.value }), createdAt);
        }
        deliveries.push({
          id, taskId: execution.taskId, submissionId: request.submissionId, edgeId: target.edgeId,
          fromEndpoint: execution.nodeId, toEndpoint: target.toEndpoint, value: target.value,
          protocol: target.protocol, revisionVersion: revision.version, seq, state: 'accepted',
          source: 'submission' as const, createdAt,
        });
      }
      this.store.db.prepare('UPDATE kernel_executions SET submission_id=?, missing_required=0 WHERE id=?').run(request.submissionId, executionId);
      return { submissionId: request.submissionId, replayed: false, deliveries, noRecipients: deliveries.length === 0 };
    });
  }

  /** A second submit for one execution: an identical replay returns the receipt; anything else is refused. */
  private replayOrRefuse(execution: ExecutionRow, request: SubmitRequest, existing: { id: string; content_digest: string }): SubmitReceipt {
    const digest = canonicalJson({ outputs: request.outputs });
    if (existing.id === request.submissionId && existing.content_digest === digest) {
      const deliveries = this.deliveriesFor(execution.id);
      return { submissionId: request.submissionId, replayed: true, deliveries, noRecipients: deliveries.length === 0 };
    }
    throw new RuntimeError('invalid_submit', `Execution ${execution.id} already submitted; only one valid submission per execution is allowed`);
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

  /** Queue a delivery for a node without a submission, in acceptance order (§7). */
  enqueueDelivery(taskId: string, nodeId: string, payload: Json): void {
    this.store.db.prepare('INSERT INTO kernel_queue(task_id,node_id,kind,payload,created_at) VALUES(?,?,?,?,?)')
      .run(taskId, nodeId, 'delivery', canonicalJson(payload), Date.now());
  }

  // ---- node queue and per-node retry state (§7) -------------------------------

  /** Append one input to a node's serial queue. Returns the accepted row. */
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
    this.store.transaction(() => {
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
    this.store.transaction(() => this.setModuleInputInTransaction(taskId, moduleId, name, value, source));
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
    this.store.transaction(() => {
      this.store.db.prepare('INSERT INTO kernel_module_transitions(id,task_id,module_id,input_name,input_value,state_before,state_after,verdict,outputs,rule_version,reason,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, taskId, input.moduleId, input.inputName, canonicalJson(input.inputValue), canonicalJson(input.stateBefore), canonicalJson(input.stateAfter), input.verdict, canonicalJson(input.outputs), input.ruleVersion, input.reason, createdAt);
      this.store.db.prepare('UPDATE kernel_modules SET state=?, rule_version=?, triggered=? WHERE task_id=? AND module_id=?')
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
