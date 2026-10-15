import { execFile } from 'node:child_process';
import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalJson, type TaskStore } from './store.ts';
import { RuntimeError, type Json } from './types.ts';

const runGit = promisify(execFile);
export const ARTIFACT_MAX_BYTES = 16 * 1024 * 1024;
export const ARTIFACT_TASK_QUOTA_BYTES = 256 * 1024 * 1024;
// 这是「版本号上限」，不是「存活版本数」：退役不释放，所以到顶之后该逻辑键就永远不能再发新版。
// 100 在实践里判死了一份持续演进的长清单（主 Agent 要长期维护的 durable backlog 正好停在第 100 版）。
// 真正的容量闸门是下面的 ARTIFACT_TASK_QUOTA_BYTES（版本行本身很小，且内容按 digest 去重）。
export const ARTIFACT_MAX_VERSIONS = 1_000;
export const ARTIFACT_MAX_PUBLISHES_PER_OPERATION = 32;

export type ArtifactScope = 'task' | 'project';
export type ArtifactTrust = 'unverified' | 'reviewed' | 'accepted';
export type ArtifactState = 'published' | 'retired';

export interface ArtifactProducer {
  nodeId: string;
  instanceId: string;
  operationId: string;
  activationId: string;
  outputVersion?: number;
}

export interface ArtifactRecord {
  artifactId: string;
  version: number;
  scope: ArtifactScope;
  ownerId: string;
  taskId: string;
  projectId: string | null;
  namespace: string;
  name: string;
  logicalKey: string;
  digest: string;
  objectPath: string;
  size: number;
  mediaType: string;
  schemaKind: string | null;
  schemaVersion: number | null;
  title: string | null;
  summary: string | null;
  tags: string[];
  producer: ArtifactProducer | null;
  visibility: string;
  trust: ArtifactTrust;
  state: ArtifactState;
  supersedes: { artifactId: string; version: number } | null;
  metadata: Record<string, unknown>;
  uri: string;
  createdAt: number;
  retiredAt: number | null;
}

export interface PublishArtifactInput {
  taskId: string;
  workspace: string;
  namespace: string;
  name: string;
  sourcePath?: string;
  content?: string;
  mediaType?: string;
  schema?: string;
  title?: string;
  summary?: string;
  tags?: string[];
  expectedVersion?: number;
  producer: ArtifactProducer;
  requestId: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactQuery {
  artifactId?: string;
  taskId: string;
  namespace?: string;
  prefix?: string;
  schema?: string;
  tag?: string;
  trust?: ArtifactTrust;
  includeRetired?: boolean;
  latestOnly?: boolean;
  limit?: number;
  cursor?: string;
}

/** A listing query that does not name a task: everything but `taskId`. */
export type ProjectArtifactQuery = Omit<ArtifactQuery, 'taskId'> & {
  /** Read the project's tasks too, not only what belongs to the project itself. */
  includeTaskArtifacts?: boolean;
};

export interface ArtifactPage {
  artifacts: ArtifactRecord[];
  nextCursor: string | null;
  total: number;
}

function within(root: string, target: string) {
  return root === sep ? target.startsWith(sep) : target === root || target.startsWith(`${root}${sep}`);
}

function requiredText(value: string, field: string, max: number) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new RuntimeError('invalid_artifact', `${field} must be a nonempty string of at most ${max} characters`);
  }
  return value.trim();
}

function optionalText(value: string | undefined, field: string, max: number) {
  if (value === undefined) return null;
  return requiredText(value, field, max);
}

function slug(value: string, field: string) {
  const normalized = requiredText(value, field, 120).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(normalized)) {
    throw new RuntimeError('invalid_artifact', `${field} must be a lowercase slug`);
  }
  return normalized;
}

function parseSchema(value: string | undefined) {
  if (value === undefined) return { kind: null, version: null };
  const match = /^([a-z][a-z0-9._-]*)@([1-9]\d*)$/.exec(value);
  if (!match) throw new RuntimeError('invalid_artifact', 'schema must use kind@version syntax');
  return { kind: match[1]!, version: Number(match[2]) };
}

// Tags are labels, not path components: any writing system is allowed, but the shape stays
// slug-like (a letter or digit at both ends) so a tag remains a safe filter token.
function tag(value: string, field: string) {
  const normalized = requiredText(value, field, 60).toLowerCase();
  if (!/^[\p{L}\p{N}](?:[\p{L}\p{N}._-]*[\p{L}\p{N}])?$/u.test(normalized)) {
    throw new RuntimeError('invalid_artifact', `${field} must be a label of letters, digits, dot, dash or underscore in any script (at most 60 characters)`);
  }
  return normalized;
}

function normalizeTags(value: string[] | undefined) {
  const tags = [...new Set((value ?? []).map(entry => tag(entry, 'tag')))].sort();
  if (tags.length > 20) throw new RuntimeError('invalid_artifact', 'An artifact may have at most 20 tags');
  return tags;
}

function artifactUri(scope: ArtifactScope, ownerId: string, namespace: string, name: string, version: number) {
  const owner = scope === 'task' ? 'tasks' : 'projects';
  return `graph://${owner}/${encodeURIComponent(ownerId)}/artifacts/${encodeURIComponent(namespace)}/${encodeURIComponent(name)}@${version}`;
}

function mapArtifact(row: Record<string, unknown>): ArtifactRecord {
  const producer = row.producer_node_id && row.producer_instance_id && row.producer_operation_id
    ? {
        nodeId: String(row.producer_node_id),
        instanceId: String(row.producer_instance_id),
        operationId: String(row.producer_operation_id),
        activationId: String(row.producer_activation_id ?? ''),
        ...(row.producer_output_version === null || row.producer_output_version === undefined
          ? {}
          : { outputVersion: Number(row.producer_output_version) }),
      }
    : null;
  return {
    artifactId: String(row.artifact_id),
    version: Number(row.version),
    scope: String(row.scope) as ArtifactScope,
    ownerId: String(row.owner_id),
    taskId: String(row.task_id),
    projectId: row.project_id === null || row.project_id === undefined ? null : String(row.project_id),
    namespace: String(row.namespace),
    name: String(row.name),
    logicalKey: String(row.logical_key),
    digest: String(row.digest),
    objectPath: String(row.object_path),
    size: Number(row.size),
    mediaType: String(row.media_type),
    schemaKind: row.schema_kind === null || row.schema_kind === undefined ? null : String(row.schema_kind),
    schemaVersion: row.schema_version === null || row.schema_version === undefined ? null : Number(row.schema_version),
    title: row.title === null || row.title === undefined ? null : String(row.title),
    summary: row.summary === null || row.summary === undefined ? null : String(row.summary),
    tags: JSON.parse(String(row.tags ?? '[]')) as string[],
    producer,
    visibility: String(row.visibility),
    trust: String(row.trust) as ArtifactTrust,
    state: String(row.state) as ArtifactState,
    supersedes: row.supersedes_artifact_id && row.supersedes_version !== null && row.supersedes_version !== undefined
      ? { artifactId: String(row.supersedes_artifact_id), version: Number(row.supersedes_version) }
      : null,
    metadata: JSON.parse(String(row.metadata ?? '{}')) as Record<string, unknown>,
    uri: artifactUri(String(row.scope) as ArtifactScope, String(row.owner_id), String(row.namespace), String(row.name), Number(row.version)),
    createdAt: Number(row.created_at),
    retiredAt: row.retired_at === null || row.retired_at === undefined ? null : Number(row.retired_at),
  };
}

function contentMediaType(path: string, supplied?: string) {
  if (supplied) {
    const value = supplied.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)) {
      throw new RuntimeError('invalid_artifact', 'mediaType must be a valid MIME type');
    }
    return value;
  }
  const extension = basename(path).split('.').at(-1)?.toLowerCase();
  if (extension && ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'rs', 'go', 'c', 'cc', 'cpp', 'h', 'java', 'swift', 'sh'].includes(extension)) return 'text/plain';
  return ({
    json: 'application/json',
    jsonl: 'application/x-ndjson',
    md: 'text/markdown',
    markdown: 'text/markdown',
    txt: 'text/plain',
    csv: 'text/csv',
    html: 'text/html',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    pdf: 'application/pdf',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  } as Record<string, string>)[extension ?? ''] ?? 'application/octet-stream';
}

function objectRelativePath(digest: string) {
  return join('objects', 'sha256', digest.slice(0, 2), digest);
}

export class ArtifactWorkspace {
  private readonly store: TaskStore;
  private readonly root: string;

  constructor(store: TaskStore, root: string) {
    this.store = store;
    this.root = root;
  }

  private async ensureRoot() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    return realpath(this.root);
  }

  private async source(input: PublishArtifactInput) {
    if ((input.sourcePath === undefined) === (input.content === undefined)) {
      throw new RuntimeError('invalid_artifact', 'Exactly one of sourcePath or content is required');
    }
    if (input.content !== undefined) {
      const data = Buffer.from(input.content, 'utf8');
      if (data.length > ARTIFACT_MAX_BYTES) throw new RuntimeError('artifact_quota', `Artifact exceeds the ${ARTIFACT_MAX_BYTES} byte limit`);
      return {
        data,
        digest: createHash('sha256').update(data).digest('hex'),
        filename: `${input.name}.txt`,
      };
    }
    const workspace = await realpath(input.workspace);
    const sourcePath = input.sourcePath!;
    const candidate = isAbsolute(sourcePath) ? resolve(sourcePath) : resolve(workspace, sourcePath);
    const info = await lstat(candidate).catch(() => undefined);
    if (!info) throw new RuntimeError('invalid_artifact', 'sourcePath does not exist');
    if (info.isSymbolicLink()) throw new RuntimeError('invalid_artifact', 'sourcePath may not be a symbolic link');
    if (!info.isFile()) throw new RuntimeError('invalid_artifact', 'sourcePath must be a regular file');
    if (info.nlink > 1) throw new RuntimeError('invalid_artifact', 'sourcePath may not be a multiply-linked file');
    const canonical = await realpath(candidate);
    if (!within(workspace, canonical)) throw new RuntimeError('invalid_artifact', 'sourcePath escaped the operation workspace: write the report inside your work copy and publish that path, or pass its bytes as content');
    if (info.size > ARTIFACT_MAX_BYTES) throw new RuntimeError('artifact_quota', `Artifact exceeds the ${ARTIFACT_MAX_BYTES} byte limit`);
    const data = await readFile(canonical);
    if (data.length > ARTIFACT_MAX_BYTES) throw new RuntimeError('artifact_quota', `Artifact exceeds the ${ARTIFACT_MAX_BYTES} byte limit`);
    const digest = createHash('sha256').update(data).digest('hex');
    return { data, digest, filename: basename(canonical) };
  }

  private async ensureObject(root: string, digest: string, data: Buffer) {
    const relative = objectRelativePath(digest);
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(target, 'wx', 0o400);
      await handle.writeFile(data);
      await handle.sync();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await stat(target);
      if (!existing.isFile() || existing.size !== data.length) throw new RuntimeError('artifact_integrity', 'Existing object does not match its digest path');
    } finally {
      await handle?.close();
    }
    await chmod(target, 0o400);
    return relative;
  }

  /**
   * The tasks whose task-scope artifacts a caller may see.
   *
   * A main agent dispatches subagents into their own feature tasks, and those tasks publish what they
   * produce, so visibility follows the conversation: a task sees its own artifacts plus those of every
   * task in the same conversation. Promotion stays the separate, explicit act that turns one artifact
   * into project-wide knowledge for later tasks, which is why nothing crosses a conversation boundary
   * without it. A task with no conversation sees only its own, exactly as before.
   */
  private readonly visibleTasks = '(id=? OR (conversation_id IS NOT NULL AND conversation_id=(SELECT conversation_id FROM tasks WHERE id=?)))';

  private assertScope(record: ArtifactRecord, taskId: string) {
    const task = this.store.task(taskId);
    const visible = record.scope === 'task'
      ? Boolean(this.store.db.prepare(`SELECT 1 FROM tasks WHERE ${this.visibleTasks} AND id=?`).get(taskId, taskId, record.ownerId))
      : Boolean(task.project_id && record.projectId === task.project_id);
    if (!visible) throw new RuntimeError('not_found', 'Artifact not found in this task workspace');
    return record;
  }

  private current(taskId: string, namespace: string, name: string) {
    return this.store.db.prepare(`SELECT artifact_id,version FROM artifacts
      WHERE scope='task' AND owner_id=? AND namespace=? AND name=?
      ORDER BY version DESC LIMIT 1`).get(taskId, namespace, name) as { artifact_id: string; version: number } | undefined;
  }

  private artifactEvent(taskId: string, record: Pick<ArtifactRecord, 'artifactId' | 'version'>, type: string, data: unknown) {
    this.store.db.prepare(`INSERT INTO artifact_events(task_id,artifact_id,version,type,data,timestamp)
      VALUES(?,?,?,?,?,?)`).run(taskId, record.artifactId, record.version, type, canonicalJson(data), Date.now());
  }

  private taskBytes(taskId: string) {
    const row = this.store.db.prepare('SELECT COALESCE(SUM(size),0) AS bytes FROM artifacts WHERE task_id=?').get(taskId) as { bytes: number };
    return Number(row.bytes);
  }

  private operationPublishes(operationId: string) {
    const row = this.store.db.prepare('SELECT COUNT(*) AS count FROM artifacts WHERE producer_operation_id=?').get(operationId) as { count: number };
    return Number(row.count);
  }

  private replay<T>(scope: string, requestId: string, payload: unknown): T | undefined {
    const previous = this.store.db.prepare('SELECT payload,receipt FROM commands WHERE scope=? AND request_id=?')
      .get(scope, requestId) as { payload: string; receipt: string } | undefined;
    if (!previous) return undefined;
    if (previous.payload !== canonicalJson(payload)) {
      throw new RuntimeError('idempotency_conflict', 'requestId was already used with different artifact content');
    }
    return JSON.parse(previous.receipt) as T;
  }

  /**
   * The newest published version of one logical key inside this task, or undefined.
   *
   * Used where a caller must not mint a version that is byte-identical to what it already holds:
   * the same review published twice says nothing new, and a version chain that cannot be trusted to
   * mean "something changed" stops being a record of anything.
   */
  head(taskId: string, logicalKey: string): ArtifactRecord | undefined {
    this.store.task(taskId);
    const row = this.store.db.prepare(
      "SELECT * FROM artifacts WHERE scope='task' AND owner_id=? AND logical_key=? AND state='published' ORDER BY version DESC LIMIT 1",
    ).get(taskId, logicalKey) as Record<string, unknown> | undefined;
    return row ? mapArtifact(row) : undefined;
  }

  private async stableCode(input: PublishArtifactInput, data: Buffer, metadata: Record<string, unknown>, actor: string | null): Promise<Record<string, unknown>> {
    if (actor === null) return metadata;
    const fileCode = input.sourcePath && /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|c|cc|cpp|h|java|swift|sh)$/i.test(input.sourcePath);
    if (!fileCode && metadata.kind !== 'code' && metadata.code === undefined) return metadata;
    const supplied = metadata.code as { commit?: unknown; repository?: unknown; worktree?: unknown } | undefined;
    if (supplied !== undefined && (!supplied || typeof supplied !== 'object' || Array.isArray(supplied))) throw new RuntimeError('invalid_code_ref', 'Code metadata requires {repository,commit,worktree?}');
    const repository = typeof supplied?.repository === 'string' ? resolve(supplied.repository) : resolve(input.workspace);
    if (repository !== resolve(input.workspace)) throw new RuntimeError('permission', 'Publish code from this execution workspace; another repository requires its own authorized execution');
    try {
      const commit = (await runGit('git', ['-C', repository, 'rev-parse', '--verify', `${typeof supplied?.commit === 'string' ? supplied.commit : 'HEAD'}^{commit}`], { maxBuffer: 4096 })).stdout.trim();
      if (input.sourcePath) {
        const root = (await runGit('git', ['-C', repository, 'rev-parse', '--show-toplevel'], { maxBuffer: 4096 })).stdout.trim();
        const source = resolve(input.workspace, input.sourcePath!);
        const path = relative(root, source);
        if (path.startsWith('..') || isAbsolute(path)) throw new Error('Code file is outside its repository');
        const snapshot = await runGit('git', ['-C', repository, 'show', `${commit}:${path}`], { encoding: 'buffer', maxBuffer: ARTIFACT_MAX_BYTES });
        if (!snapshot.stdout.equals(data)) throw new Error('File differs from its commit; commit the changes before publishing');
      }
      return { ...metadata, kind: 'code', code: { repository, commit, worktree: input.workspace } };
    } catch (error) { throw new RuntimeError('invalid_code_ref', error instanceof Error ? error.message : 'Code artifact requires a stable commit'); }
  }

  private graphPublisher(taskId: string, producer: ArtifactProducer): string | null {
    const exists = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='kernel_revisions'").get();
    if (!exists || !this.store.db.prepare('SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1').get(taskId)) return null;
    const execution = this.store.db.prepare('SELECT e.task_id,e.node_id,n.instance_id FROM kernel_executions e JOIN kernel_nodes n ON n.task_id=e.task_id AND n.node_id=e.node_id WHERE e.id=?').get(producer.operationId) as { task_id: string; node_id: string; instance_id: string } | undefined;
    if (execution?.task_id === taskId && execution.node_id === producer.nodeId && execution.instance_id === producer.instanceId) return execution.node_id;
    const main = this.store.db.prepare(`SELECT 1 FROM operations o
      JOIN nodes n ON n.task_id=o.task_id AND n.id=o.node_id
      JOIN tasks t ON t.id=?
      LEFT JOIN kernel_graph_owners g ON g.task_id=t.id AND g.owner_task_id=o.task_id
      LEFT JOIN conversations c ON c.id=t.conversation_id AND c.anchor_task_id=o.task_id
      WHERE o.id=? AND o.node_id=? AND o.instance_id=? AND o.activation_id=?
        AND json_extract(n.spec,'$.role')='master' AND (g.task_id IS NOT NULL OR c.id IS NOT NULL)`)
      .get(taskId, producer.operationId, producer.nodeId, producer.instanceId, producer.activationId);
    if (main) return 'main';
    throw new RuntimeError('permission', 'Artifact publisher does not match a graph execution or its main owner');
  }

  private assertGraphAuthor(taskId: string, namespace: string, name: string, actor: string | null): void {
    if (actor === null || actor === 'main') return;
    const first = this.store.db.prepare("SELECT producer_node_id FROM artifacts WHERE owner_id=? AND scope='task' AND namespace=? AND name=? ORDER BY version LIMIT 1").get(taskId, namespace, name) as { producer_node_id: string } | undefined;
    if (first && first.producer_node_id !== actor) throw new RuntimeError('permission', 'Only the original publisher may modify this artifact; publish a separate revision');
  }

  async publish(input: PublishArtifactInput): Promise<ArtifactRecord> {
    this.store.task(input.taskId);
    const namespace = slug(input.namespace, 'namespace');
    const name = slug(input.name, 'name');
    const actor = this.graphPublisher(input.taskId, input.producer);
    this.assertGraphAuthor(input.taskId, namespace, name, actor);
    const schema = parseSchema(input.schema);
    const tags = normalizeTags(input.tags);
    const title = optionalText(input.title, 'title', 300);
    const summary = optionalText(input.summary, 'summary', 2_000);
    let metadata = input.metadata ?? {};
    requiredText(input.requestId, 'requestId', 200);
    const commandScope = `artifact-publish:${input.taskId}`;
    const commandPayload = {
      namespace,
      name,
      sourcePath: input.sourcePath ?? null,
      content: input.content ?? null,
      mediaType: input.mediaType ?? null,
      schema: input.schema ?? null,
      title,
      summary,
      tags,
      expectedVersion: input.expectedVersion ?? null,
      producer: input.producer,
      metadata,
    };
    const replay = this.replay<ArtifactRecord>(commandScope, input.requestId, commandPayload);
    if (replay) return replay;
    const current = this.current(input.taskId, namespace, name);
    const latest = current?.version ?? 0;
    const expected = input.expectedVersion ?? latest;
    if (!Number.isSafeInteger(expected) || expected < 0) throw new RuntimeError('invalid_artifact', 'expectedVersion must be a nonnegative integer');
    if (expected !== latest) {
      throw new RuntimeError('artifact_conflict', `Artifact head changed: expected version ${expected}, found ${latest}`);
    }
    if (latest >= ARTIFACT_MAX_VERSIONS) throw new RuntimeError('artifact_quota', `Artifact may have at most ${ARTIFACT_MAX_VERSIONS} versions`);
    if (this.operationPublishes(input.producer.operationId) >= ARTIFACT_MAX_PUBLISHES_PER_OPERATION) {
      throw new RuntimeError('artifact_quota', `An operation may publish at most ${ARTIFACT_MAX_PUBLISHES_PER_OPERATION} artifacts`);
    }
    const source = await this.source(input);
    metadata = await this.stableCode(input, source.data, metadata, actor);
    if (actor && actor !== 'main') metadata = { ...metadata, subgraphPath: actor.includes('/') ? actor.slice(0, actor.lastIndexOf('/')) : null };
    if (this.taskBytes(input.taskId) + source.data.length > ARTIFACT_TASK_QUOTA_BYTES) {
      throw new RuntimeError('artifact_quota', `Task artifact workspace exceeds ${ARTIFACT_TASK_QUOTA_BYTES} bytes`);
    }
    const root = await this.ensureRoot();
    const relative = await this.ensureObject(root, source.digest, source.data);
    const record = this.store.command<ArtifactRecord>(commandScope, input.requestId, commandPayload, () => {
      this.assertGraphAuthor(input.taskId, namespace, name, actor);
      const fresh = this.current(input.taskId, namespace, name);
      const freshLatest = fresh?.version ?? 0;
      if (freshLatest !== expected) {
        throw new RuntimeError('artifact_conflict', `Artifact head changed: expected version ${expected}, found ${freshLatest}`);
      }
      if (freshLatest >= ARTIFACT_MAX_VERSIONS) throw new RuntimeError('artifact_quota', `Artifact may have at most ${ARTIFACT_MAX_VERSIONS} versions`);
      if (this.operationPublishes(input.producer.operationId) >= ARTIFACT_MAX_PUBLISHES_PER_OPERATION) {
        throw new RuntimeError('artifact_quota', `An operation may publish at most ${ARTIFACT_MAX_PUBLISHES_PER_OPERATION} artifacts`);
      }
      if (this.taskBytes(input.taskId) + source.data.length > ARTIFACT_TASK_QUOTA_BYTES) {
        throw new RuntimeError('artifact_quota', `Task artifact workspace exceeds ${ARTIFACT_TASK_QUOTA_BYTES} bytes`);
      }
      const version = freshLatest + 1;
      const artifactId = fresh?.artifact_id ?? randomUUID();
      const createdAt = Date.now();
      const row = {
        artifactId,
        version,
        scope: 'task' as const,
        ownerId: input.taskId,
        taskId: input.taskId,
        projectId: null,
        namespace,
        name,
        logicalKey: `${namespace}/${name}`,
        digest: source.digest,
        objectPath: relative,
        size: source.data.length,
        mediaType: contentMediaType(source.filename, input.mediaType),
        schemaKind: schema.kind,
        schemaVersion: schema.version,
        title,
        summary,
        tags,
        producer: input.producer,
        visibility: 'task',
        trust: 'unverified' as const,
        state: 'published' as const,
        supersedes: freshLatest ? { artifactId, version: freshLatest } : null,
        metadata,
        uri: artifactUri('task', input.taskId, namespace, name, version),
        createdAt,
        retiredAt: null,
      };
      this.store.db.prepare(`INSERT INTO artifacts(
        artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,object_path,size,
        media_type,schema_kind,schema_version,title,summary,tags,producer_node_id,producer_instance_id,
        producer_operation_id,producer_activation_id,producer_output_version,visibility,trust,state,
        supersedes_artifact_id,supersedes_version,metadata,created_at,retired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        row.artifactId, row.version, row.scope, row.ownerId, row.taskId, row.projectId, row.namespace, row.name,
        row.logicalKey, row.digest, row.objectPath, row.size, row.mediaType, row.schemaKind, row.schemaVersion,
        row.title, row.summary, canonicalJson(row.tags), input.producer.nodeId, input.producer.instanceId,
        input.producer.operationId, input.producer.activationId, input.producer.outputVersion ?? null,
        row.visibility, row.trust, row.state, row.supersedes?.artifactId ?? null, row.supersedes?.version ?? null,
        canonicalJson(row.metadata), row.createdAt, row.retiredAt,
      );
      this.store.db.prepare(`INSERT OR IGNORE INTO artifact_links(id,artifact_id,version,subject_kind,subject_id,relation,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), artifactId, version, 'operation', input.producer.operationId, 'produced_by', createdAt);
      this.artifactEvent(input.taskId, row, 'artifact.published', {
        artifactId, version, namespace, name, digest: source.digest, size: source.data.length,
      });
      return row;
    });
    this.store.event(input.taskId, 'artifact.published', {
      artifactId: record.artifactId, version: record.version, namespace, name, digest: source.digest, size: source.data.length,
    });
    return record;
  }

  /**
   * Artifacts that belong to a project rather than to one task: what promotion puts in project
   * scope. Listing never touches an artifact's bytes, so it needs no task context - reading the
   * content still does, and that is what `read` requires.
   */
  listProject(projectId: string, input: ProjectArtifactQuery = {}): ArtifactPage {
    // A project's shared artifacts are the ones it owns; an index of everything published in the
    // project also needs what each of the project's tasks published.
    if (input.includeTaskArtifacts) {
      return this.page(
        [`((scope='project' AND owner_id=?) OR (scope='task' AND owner_id IN (SELECT id FROM tasks WHERE project_id=?)))`],
        [projectId, projectId],
        input,
      );
    }
    return this.page([`(scope='project' AND owner_id=?)`], [projectId], input);
  }

  list(input: ArtifactQuery): ArtifactPage {
    const task = this.store.task(input.taskId);
    const conditions = [`((scope=\'task\' AND owner_id IN (SELECT id FROM tasks WHERE ${this.visibleTasks}))` + (task.project_id ? ' OR (scope=\'project\' AND project_id=?)' : '') + ')'];
    const params: unknown[] = task.project_id ? [input.taskId, input.taskId, task.project_id] : [input.taskId, input.taskId];
    return this.page(conditions, params, input);
  }

  /** Graph nodes discover only the shared workspace owned by their top-level graph. */
  listGraph(graphId: string, input: Omit<ArtifactQuery, 'taskId'> = {}): ArtifactPage {
    this.store.task(graphId);
    return this.page(["scope='task' AND owner_id=?"], [graphId], input);
  }

  private page(conditions: string[], params: unknown[], input: ProjectArtifactQuery): ArtifactPage {
    if (input.artifactId) { conditions.push('artifact_id=?'); params.push(input.artifactId); }
    if (input.namespace) { conditions.push('namespace=?'); params.push(slug(input.namespace, 'namespace')); }
    if (input.prefix) { conditions.push('name LIKE ?'); params.push(`${slug(input.prefix, 'prefix')}%`); }
    if (input.schema) {
      const schema = parseSchema(input.schema);
      conditions.push('schema_kind=? AND schema_version=?');
      params.push(schema.kind, schema.version);
    }
    if (input.tag) {
      conditions.push('EXISTS (SELECT 1 FROM json_each(artifacts.tags) WHERE value=?)');
      params.push(tag(input.tag, 'tag'));
    }
    if (input.trust) { conditions.push('trust=?'); params.push(input.trust); }
    const where = conditions.join(' AND ');
    const limit = Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100)));
    const offset = Math.max(0, Number.parseInt(input.cursor ?? '0', 10) || 0);
    const ranked = input.latestOnly === false
      ? `SELECT * FROM artifacts WHERE ${where}`
      : `SELECT * FROM (
          SELECT *,ROW_NUMBER() OVER (
            PARTITION BY scope,owner_id,namespace,name ORDER BY version DESC
          ) AS artifact_rank
          FROM artifacts WHERE ${where}
        ) WHERE artifact_rank=1`;
    const visible = input.includeRetired ? ranked : `SELECT * FROM (${ranked}) WHERE state='published'`;
    const totalRow = this.store.db.prepare(`SELECT COUNT(*) AS count FROM (${visible})`).get(...params as never[]) as { count: number };
    const rows = this.store.db.prepare(`${visible} ORDER BY created_at DESC,artifact_id,version DESC LIMIT ? OFFSET ?`)
      .all(...params as never[], limit, offset) as Record<string, unknown>[];
    return {
      artifacts: rows.map(mapArtifact),
      nextCursor: offset + rows.length < Number(totalRow.count) ? String(offset + rows.length) : null,
      total: Number(totalRow.count),
    };
  }

  /**
   * One artifact version. Promotion mints a new artifact identity, so a version is unambiguous in
   * practice; the optional scope is for callers that came from a named row and want to say so
   * rather than rely on that.
   */
  get(taskId: string, artifactId: string, version?: number, scope?: 'task' | 'project') {
    const scoped = scope ? ' AND scope=?' : '';
    const tail = scope ? [artifactId, scope] : [artifactId];
    const row = version === undefined
      ? this.store.db.prepare(`SELECT * FROM artifacts WHERE artifact_id=?${scoped} ORDER BY version DESC LIMIT 1`).get(...tail as never[])
      : this.store.db.prepare(`SELECT * FROM artifacts WHERE artifact_id=? AND version=?${scoped} ORDER BY CASE scope WHEN 'task' THEN 0 ELSE 1 END LIMIT 1`).get(...(scope ? [artifactId, version, scope] : [artifactId, version]) as never[]);
    if (!row) throw new RuntimeError('not_found', 'Artifact not found');
    return this.assertScope(mapArtifact(row as Record<string, unknown>), taskId);
  }

  /** A bounded, complete snapshot for final evidence; preview truncation cannot prove a report. */
  readVerifiedContent(taskId: string, artifactId: string, version: number, maxBytes = 1_048_576): Buffer {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) throw new RuntimeError('invalid_artifact', 'Evidence limit must be between 1 byte and 4 MiB');
    const record = this.get(taskId, artifactId, version);
    const root = realpathSync(this.root);
    const path = resolve(root, record.objectPath);
    if (!within(root, path) || !within(root, realpathSync(path))) throw new RuntimeError('artifact_integrity', 'Artifact object path escaped the workspace root');
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.size > maxBytes || info.size !== record.size) throw new RuntimeError('artifact_integrity', 'Evidence bytes are unavailable within the limit');
      const buffer = Buffer.alloc(maxBytes + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = readSync(fd, buffer, size, buffer.length - size, null);
        if (!count) break;
        size += count;
      }
      const data = buffer.subarray(0, size);
      if (size !== record.size || size > maxBytes || createHash('sha256').update(data).digest('hex') !== record.digest) throw new RuntimeError('artifact_integrity', 'Evidence no longer matches its published version');
      return data;
    } finally { closeSync(fd); }
  }

  async read(taskId: string, artifactId: string, version: number, maxBytes = 262_144, scope?: 'task' | 'project') {
    const record = this.get(taskId, artifactId, version, scope);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 4 * 1024 * 1024) {
      throw new RuntimeError('invalid_artifact', 'maxBytes must be between 1 byte and 4 MiB');
    }
    const root = await this.ensureRoot();
    const path = resolve(root, record.objectPath);
    if (!within(root, path)) throw new RuntimeError('artifact_integrity', 'Artifact object path escaped the workspace root');
    const data = await readFile(path);
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== record.digest || data.length !== record.size) throw new RuntimeError('artifact_integrity', 'Artifact content no longer matches its published digest');
    this.store.transaction(() => this.artifactEvent(taskId, record, 'artifact.accessed', {
      artifactId: record.artifactId,
      version: record.version,
    }));
    const events = (this.store.db.prepare(`SELECT type,data,timestamp FROM artifact_events
      WHERE artifact_id=? AND version=? ORDER BY cursor DESC LIMIT 20`)
      .all(record.artifactId, record.version) as { type: string; data: string; timestamp: number }[])
      .map(event => ({ type: event.type, data: JSON.parse(event.data) as Json, timestamp: event.timestamp }));
    const text = record.mediaType.startsWith('text/')
      || ['application/json', 'application/xml', 'application/yaml', 'application/x-ndjson'].includes(record.mediaType);
    return {
      record,
      text: text && data.length <= maxBytes ? data.toString('utf8') : null,
      truncated: text && data.length > maxBytes,
      path,
      bytes: data.length,
      events,
    };
  }

  retire(taskId: string, artifactId: string, version: number, reason: string, requestId: string, actor?: ArtifactProducer | 'main') {
    const record = this.get(taskId, artifactId, version);
    const ownerTaskId = record.scope === 'task' ? record.ownerId : taskId;
    const v2 = this.store.db.prepare("SELECT 1 FROM sqlite_master WHERE name='kernel_revisions'").get()
      && this.store.db.prepare('SELECT 1 FROM kernel_revisions WHERE task_id=? LIMIT 1').get(ownerTaskId);
    const targetTaskId = v2 ? ownerTaskId : taskId;
    if (v2) {
      if (!actor) throw new RuntimeError('permission', 'Artifact retirement requires the publisher or main owner');
      const publisher = actor === 'main' ? 'main' : this.graphPublisher(targetTaskId, actor);
      this.assertGraphAuthor(targetTaskId, record.namespace, record.name, publisher);
    }
    if (record.state === 'retired') return record;
    const commandScope = `artifact-retire:${targetTaskId}`;
    const commandPayload = { artifactId, version, reason: requiredText(reason, 'reason', 1_000) };
    const replay = this.replay<ArtifactRecord>(commandScope, requiredText(requestId, 'requestId', 200), commandPayload);
    if (replay) return replay;
    const retiredAt = Date.now();
    const retired = this.store.command<ArtifactRecord>(commandScope, requestId, commandPayload, () => {
      this.store.db.prepare('UPDATE artifacts SET state=\'retired\',retired_at=? WHERE artifact_id=? AND version=?')
        .run(retiredAt, artifactId, version);
      this.artifactEvent(targetTaskId, record, 'artifact.retired', commandPayload);
      return { ...record, state: 'retired' as const, retiredAt };
    });
    this.store.event(targetTaskId, 'artifact.retired', commandPayload);
    return retired;
  }

  async promote(input: {
    taskId: string;
    artifactId: string;
    version: number;
    requestId: string;
    promotedBy: string;
  }) {
    requiredText(input.requestId, 'requestId', 200);
    const task = this.store.task(input.taskId);
    if (!task.project_id) throw new RuntimeError('invalid_artifact', 'Cross-task promotion requires a project-bound task');
    const source = this.get(input.taskId, input.artifactId, input.version);
    const commandScope = `artifact-promote:${input.taskId}`;
    const commandPayload = {
      artifactId: input.artifactId,
      version: input.version,
      promotedBy: input.promotedBy,
    };
    const replay = this.replay<ArtifactRecord>(commandScope, input.requestId, commandPayload);
    if (replay) return replay;
    const record = this.store.command<ArtifactRecord>(commandScope, input.requestId, commandPayload, () => {
      const latest = this.store.db.prepare(`SELECT artifact_id,version FROM artifacts
        WHERE scope='project' AND owner_id=? AND namespace=? AND name=?
        ORDER BY version DESC LIMIT 1`).get(task.project_id, source.namespace, source.name) as { artifact_id: string; version: number } | undefined;
      const artifactId = latest?.artifact_id ?? randomUUID();
      const version = (latest?.version ?? 0) + 1;
      const createdAt = Date.now();
      this.store.db.prepare(`INSERT INTO artifacts(
        artifact_id,version,scope,owner_id,task_id,project_id,namespace,name,logical_key,digest,object_path,size,
        media_type,schema_kind,schema_version,title,summary,tags,producer_node_id,producer_instance_id,
        producer_operation_id,producer_activation_id,producer_output_version,visibility,trust,state,
        supersedes_artifact_id,supersedes_version,metadata,created_at,retired_at
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        artifactId, version, 'project', task.project_id, input.taskId, task.project_id, source.namespace, source.name,
        source.logicalKey, source.digest, source.objectPath, source.size, source.mediaType, source.schemaKind,
        source.schemaVersion, source.title, source.summary, canonicalJson(source.tags), source.producer?.nodeId ?? null,
        source.producer?.instanceId ?? null, source.producer?.operationId ?? null, source.producer?.activationId ?? null,
        source.producer?.outputVersion ?? null, 'project', source.trust, 'published',
        latest?.artifact_id ?? null, latest?.version ?? null,
        canonicalJson({ ...source.metadata, promotedFrom: source.uri, promotedBy: input.promotedBy }),
        createdAt, null,
      );
      this.store.db.prepare(`INSERT OR IGNORE INTO artifact_links(id,artifact_id,version,subject_kind,subject_id,relation,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(randomUUID(), artifactId, version, 'artifact', `${source.artifactId}@${source.version}`, 'promoted_from', createdAt);
      this.artifactEvent(input.taskId, { artifactId, version }, 'artifact.promoted', {
        artifactId, version, sourceArtifactId: source.artifactId, sourceVersion: source.version,
      });
      return {
        ...source,
        artifactId,
        version,
        scope: 'project' as const,
        ownerId: task.project_id!,
        projectId: task.project_id,
        visibility: 'project',
        supersedes: latest ? { artifactId: latest.artifact_id, version: latest.version } : null,
        metadata: { ...source.metadata, promotedFrom: source.uri, promotedBy: input.promotedBy },
        uri: artifactUri('project', task.project_id!, source.namespace, source.name, version),
        createdAt,
        retiredAt: null,
      };
    });
    this.store.event(input.taskId, 'artifact.promoted', {
      artifactId: record.artifactId,
      version: record.version,
      sourceArtifactId: source.artifactId,
      sourceVersion: source.version,
    });
    return record;
  }

  async gc(retentionMs = 7 * 24 * 60 * 60 * 1_000) {
    const root = await this.ensureRoot();
    const referenced = new Set(
      (this.store.db.prepare('SELECT DISTINCT digest FROM artifacts').all() as { digest: string }[]).map(row => row.digest),
    );
    let removed = 0;
    const objects = join(root, 'objects', 'sha256');
    const prefixes = await readdir(objects).catch(() => []);
    const cutoff = Date.now() - retentionMs;
    for (const prefix of prefixes) {
      const directory = join(objects, prefix);
      for (const entry of await readdir(directory).catch(() => [])) {
        if (referenced.has(entry)) continue;
        const path = join(directory, entry);
        const info = await stat(path).catch(() => undefined);
        if (!info?.isFile() || info.mtimeMs > cutoff) continue;
        await rm(path, { force: true });
        removed += 1;
      }
    }
    return { removed };
  }
}
