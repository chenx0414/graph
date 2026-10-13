import { MODEL_GRADES, type ModelGrade } from '../catalog/models.ts';
import type { GraphManagement } from '../core/graph-service.ts';
import { realpathSync } from 'node:fs';
import { extname, isAbsolute, sep } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityRecord, Catalog } from '../catalog/catalog.ts';
import type { AgentCombination } from '../catalog/agent-combinations.ts';
import { RuntimeError, type Json, type NodeSpec, type NativeProposal } from '../core/types.ts';
import { isHostRead, isHostWrite, type ResolvedAccessPolicy } from '../core/access-policy.ts';
import type { ArtifactPage, ArtifactRecord, ArtifactTrust, PublishArtifactInput } from '../core/artifact-workspace.ts';
import {
  listBounded, listHost, readBounded, readBoundedBytes, readHost, readHostBytes, writeBounded, writeHost,
} from './bounded-path.ts';
import { externallyGated } from './tool-gating.ts';
import { WriteLedger } from '../core/write-ledger.ts';
import { describeAgentTools, type AgentToolName } from './agent-tool-definitions.ts';
import type { ConversationToolChannel } from './conversation-tools.ts';

/** Same-graph Agent messaging, as far as the tools need it. */
export interface PeerChannel {
  list(): Promise<unknown>;
  send(input: { to: string; text: string; requestId: string }): Promise<unknown>;
}

type Supervisor = Partial<GraphManagement> & {
  propose(proposal: NativeProposal, requestId: string, options?: { newVersion?: boolean }): Promise<unknown>;
  withdrawDraft?(input: { proposalVersion: number; reason?: string; requestId: string }): Promise<unknown>;
  confirmDraft?(input: { proposalVersion: number; draftRevision: number; targetBranch: string; instruction: string; requestId: string }): Promise<unknown>;
  archiveDraft?(input: { proposalVersion: number; requestId: string }): Promise<unknown>;
  restoreDraft?(input: { proposalVersion: number; requestId: string }): Promise<unknown>;
  deleteDraft?(input: { proposalVersion: number; requestId: string }): Promise<unknown>;
  graphState?(): Promise<unknown>;
  taskStatus?(input: { taskId?: string; nodeId?: string; waitForNode?: string; timeoutMs?: number }): Promise<unknown>;
  validateProposal?(proposal: NativeProposal): Promise<unknown>;
  listProjects?(): Promise<unknown>;
  bindProject?(input: { projectId: string; requestId: string }): Promise<unknown>;
  listProblems?(): Promise<unknown>;
  /** Human acceptance checks of this conversation that nobody has looked at yet. */
  pendingHumanChecks?(): Promise<unknown>;
  /**
   * Record the main Agent's review of a human acceptance check. It is not acceptance:
   * the check stays open and stays the user's to answer.
   */
  reviewHumanCheck?(input: { questionId: string; approve: boolean; note: string; requestId: string }): Promise<unknown>;
  resolveProblem?(input: {
    questionId: string;
    action: 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate';
    response?: string;
    proof?: string;
    requestId: string;
  }): Promise<unknown>;
  /** Task control belongs to the main Agent for its own conversation, never to a worker. */
  controlTask?(input: {
    action: 'pause' | 'resume' | 'abandon' | 'set_budget' | 'steer';
    taskId?: string;
    nodeId?: string;
    text?: string;
    tokens?: number | null;
    reason?: string;
    requestId: string;
  }): Promise<unknown>;
};

type ArtifactToolService = {
  allowedNamespaces: string[];
  canPromote: boolean;
  list(query: {
    namespace?: string;
    prefix?: string;
    schema?: string;
    tag?: string;
    trust?: ArtifactTrust;
    includeRetired?: boolean;
    latestOnly?: boolean;
    limit?: number;
    cursor?: string;
  }): ArtifactPage;
  get(artifactId: string, version?: number): ArtifactRecord;
  read(artifactId: string, version: number, maxBytes?: number): Promise<{
    record: ArtifactRecord;
    text: string | null;
    truncated: boolean;
    path: string;
    bytes: number;
    events: { type: string; data: Json; timestamp: number }[];
  }>;
  publish(input: Omit<PublishArtifactInput, 'taskId' | 'workspace' | 'producer'> & { graphId?: string }): Promise<ArtifactRecord>;
  retire(artifactId: string, version: number, reason: string, requestId: string): ArtifactRecord;
  promote?(input: { artifactId: string; version: number; requestId: string }): Promise<ArtifactRecord>;
};

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: {} };
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
};

function imageMimeType(path: string) {
  return IMAGE_MIME_TYPES[extname(path).toLowerCase()];
}

function image(data: Buffer, mimeType: string) {
  return { content: [{ type: 'image' as const, data: data.toString('base64'), mimeType }], details: {} };
}

function nativeProposal(value: unknown): NativeProposal {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('definition' in value)) {
    throw new RuntimeError('invalid_proposal', 'Expected a native proposal object with definition; use schemaVersion:2 graph JSON');
  }
  return value as NativeProposal;
}

function fields(params: unknown) {
  return params as Record<string, unknown>;
}

function resourceReference(rawId: unknown, explicitVersion: unknown) {
  let id = String(rawId ?? '').trim();
  let version = typeof explicitVersion === 'string' && explicitVersion.trim()
    ? explicitVersion.trim()
    : undefined;
  const separator = id.lastIndexOf('@');
  if (separator > 0 && separator < id.length - 1) {
    const embeddedVersion = id.slice(separator + 1).trim();
    if (version && version !== embeddedVersion) {
      throw new Error(`Conflicting versions for capability ${id.slice(0, separator)}`);
    }
    version = embeddedVersion;
    id = id.slice(0, separator);
  }
  return { id, version };
}

function capabilityView(record: CapabilityRecord) {
  return {
    id: record.id,
    kind: record.kind,
    version: record.version,
    name: record.name ?? record.id,
    description: record.description ?? '',
    source: record.source,
    status: record.status,
    ...(record.role ? { role: record.role } : {}),
    ...(record.error ? { error: record.error } : {}),
    grantsNoPermission: true as const,
  };
}

/** Workspace, result, supervisor, and granted retrieval tools for a production Pi instance. */
export function agentTools(input: {
  workspace: string;
  role?: NodeSpec['role'] | 'reviewer';
  readRoots?: string[];
  commitWorkspace?: (input: { paths: string[]; message: string }) => Promise<unknown>;
  access?: ResolvedAccessPolicy;
  /** Discussion turns investigate without writing business files or running commands. */
  readOnly?: boolean;
  run?: (command: string, args: string[], signal?: AbortSignal) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  fetch?: (url: string, signal?: AbortSignal) => Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }>;
  supervisor?: Supervisor;
  /** Read-only definition snapshot for a native node's current execution. */
  readGraph?: (input: { section: string; id?: string; after?: number; limit?: number }) => unknown;
  /** How ask_user hands a question to the session that can durably record it. */
  onAskUser?: (question: { prompt: string; why: string; options: string[]; multiple: boolean }) => void;
  catalog?: Catalog;
  artifacts?: ArtifactToolService;
  /** Channels to other conversations: present only when this session may reach them at all. */
  conversations?: ConversationToolChannel;
  /** Same-graph peers: where they are, and how to send to one. Present only for a graph node. */
  peers?: PeerChannel;
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    systemDiagnostics?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    proposeSystemChange?: (input: { title: string; problem: string; change: Json; impact?: string; risk?: string }) => Promise<Record<string, unknown>>;
    applySystemChange?: (proposalId: string) => Promise<Record<string, unknown>>;
    rsiStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    rsiApply?: (input: unknown) => Promise<Record<string, unknown>>;
  };
  /**
   * Where a write is recorded: the ledger needs the lane, the turn and the tool call so the
   * change set of one turn stays one lane's own evidence.
   */
  writeLedger?: {
    ledger: WriteLedger;
    taskId: string;
    nodeId: string;
    instanceId: string | null;
    turnId: string;
  };
}): ToolDefinition[] {
  const root = realpathSync(input.workspace);
  const readRoots = (input.readRoots ?? []).map(item => realpathSync(item));
  const hostRead = isHostRead(input.access);
  const hostWrite = isHostWrite(input.access);
  const protectedReadPathExceptions = [...new Set([root, ...readRoots])];
  const protectedWritePathExceptions = hostWrite ? [root] : [];
  const pathOptions = {
    ...(input.access?.filesystem.gitMetadata === 'writable' ? { allowGitMetadata: true } : {}),
    ...(input.access?.protectedPaths.length ? { protectedPaths: input.access.protectedPaths } : {}),
    ...(protectedReadPathExceptions.length ? { protectedReadPathExceptions } : {}),
    ...(protectedWritePathExceptions.length ? { protectedWritePathExceptions } : {}),
  };
  // One read-only git surface: a whitelisted subcommand, no shell, and a hard output
  // cap so a huge diff cannot flood the context — over the cap it re-reads --stat.
  const GIT_READ_SUBCOMMANDS = ['status', 'log', 'diff', 'show', 'blame', 'describe', 'rev-parse', 'ls-files', 'shortlog', 'grep', 'rev-list'];
  const GIT_OUTPUT_LIMIT = 20_000;
  const gitText = async (args: string[], signal?: AbortSignal) => {
    const result = await input.run!('git', args, signal);
    return `exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`;
  };
  const handlers: Record<AgentToolName, ToolDefinition['execute']> = {

    graph_create: async (id: string, params: unknown) => text(JSON.stringify(await input.supervisor!.graphCreate!({ ...(params as Parameters<GraphManagement['graphCreate']>[0]), requestId: (params as { requestId?: string }).requestId ?? id }))),
    graph_patch: async (_id: string, params: unknown) => text(JSON.stringify(await input.supervisor!.graphPatch!(params as Parameters<GraphManagement['graphPatch']>[0]))),
    read_graph: async (_id: string, params: unknown) => text(JSON.stringify(await input.readGraph!(params as Parameters<NonNullable<typeof input.readGraph>>[0]))),
    graph_inspect: async (_id: string, params: unknown) => text(JSON.stringify(await input.supervisor!.graphInspect!(params as Parameters<GraphManagement['graphInspect']>[0]))),
    graph_control: async (_id: string, params: unknown) => text(JSON.stringify(await input.supervisor!.graphControl!(params as Parameters<GraphManagement['graphControl']>[0]))),
    graph_send: async (_id: string, params: unknown) => text(JSON.stringify(await input.supervisor!.graphSend!(params as Parameters<GraphManagement['graphSend']>[0]))),
    read: async (_id, params) => {
      const requested = String(fields(params).path);
      const mimeType = imageMimeType(requested);
      if (isAbsolute(requested)) {
        if (hostRead) {
          return mimeType
            ? image(await readHostBytes(requested, pathOptions), mimeType)
            : text(await readHost(requested, pathOptions));
        }
        const mount = [root, ...readRoots].find(candidate => requested === candidate || requested.startsWith(`${candidate}${sep}`));
        if (!mount) throw new Error('Path is outside the workspace');
        return mimeType
          ? image(await readBoundedBytes(mount, requested), mimeType)
          : text(await readBounded(mount, requested));
      }
      return mimeType
        ? image(await readBoundedBytes(root, requested), mimeType)
        : text(await readBounded(root, requested));
    },
    write_file: async (id: string, params: unknown) => {
      const body = fields(params);
      const requested = String(body.path);
      const capture = input.writeLedger;
      const record = (side: 'open' | 'close') => capture
        ? capture.ledger.capture(side, {
          taskId: capture.taskId, nodeId: capture.nodeId, instanceId: capture.instanceId, turnId: capture.turnId,
          toolCallId: id, toolName: 'write_file', path: requested, workspace: root,
        }).catch(() => null)
        : Promise.resolve(null);
      await record('open');
      if (hostWrite && isAbsolute(requested)) await writeHost(requested, String(body.content), pathOptions);
      else await writeBounded(root, requested, String(body.content));
      await record('close');
      return text(`Wrote ${body.path}`);
    },
    list_dir: async (_id, params) => {
      const requested = String(fields(params).path || '.');
      if (isAbsolute(requested)) {
        if (hostRead) return text((await listHost(requested, pathOptions)).join('\n'));
        const mount = [root, ...readRoots].find(candidate => requested === candidate || requested.startsWith(`${candidate}${sep}`));
        if (!mount) throw new Error('Path is outside the workspace');
        return text((await listBounded(mount, requested)).join('\n'));
      }
      return text((await listBounded(root, requested)).join('\n'));
    },
    artifact_list: async (_id: string, params: unknown) => {
      const body = fields(params);
      const trust = typeof body.trust === 'string' && body.trust.trim() ? body.trust.trim() : undefined;
      if (trust && !['unverified', 'reviewed', 'accepted'].includes(trust)) throw new Error('Unsupported artifact trust');
      return text(JSON.stringify(input.artifacts!.list({
        ...(typeof body.namespace === 'string' && body.namespace.trim() ? { namespace: body.namespace.trim() } : {}),
        ...(typeof body.prefix === 'string' && body.prefix.trim() ? { prefix: body.prefix.trim() } : {}),
        ...(typeof body.schema === 'string' && body.schema.trim() ? { schema: body.schema.trim() } : {}),
        ...(typeof body.tag === 'string' && body.tag.trim() ? { tag: body.tag.trim() } : {}),
        ...(trust ? { trust: trust as ArtifactTrust } : {}),
        ...(typeof body.includeRetired === 'boolean' ? { includeRetired: body.includeRetired } : {}),
        ...(typeof body.latestOnly === 'boolean' ? { latestOnly: body.latestOnly } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(typeof body.cursor === 'string' && body.cursor.trim() ? { cursor: body.cursor.trim() } : {}),
      })));
    },
    artifact_read: async (_id: string, params: unknown) => {
      const body = fields(params);
      const artifactId = String(body.artifactId).trim();
      if (!artifactId || artifactId.length > 200) throw new Error('A bounded artifactId is required');
      const requestedVersion = body.version === undefined ? undefined : Number(body.version);
      if (requestedVersion !== undefined && (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1)) {
        throw new Error('version must be a positive integer when provided');
      }
      const version = requestedVersion ?? input.artifacts!.get(artifactId).version;
      return text(JSON.stringify(await input.artifacts!.read(
        artifactId,
        version,
        typeof body.maxBytes === 'number' ? body.maxBytes : undefined,
      )));
    },
    workspace_commit: async (_id, params) => {
      const body = fields(params);
      if (!Array.isArray(body.paths) || body.paths.some(path => typeof path !== 'string') || typeof body.message !== 'string') throw new RuntimeError('invalid_input', 'workspace_commit requires paths and message');
      return text(JSON.stringify(await input.commitWorkspace!({ paths: body.paths as string[], message: body.message })));
    },
    artifact_publish: async (_id: string, params: unknown) => {
      const body = fields(params);
      if (body.graphId !== undefined && input.role !== 'master') throw new RuntimeError('permission', 'Only main can select an artifact graph');
      if (body.graphId !== undefined && (typeof body.graphId !== 'string' || !body.graphId.trim())) throw new RuntimeError('invalid_input', 'graphId must be a nonempty string');
      const namespace = String(body.namespace).trim();
      if (!input.artifacts!.allowedNamespaces.includes(namespace)) throw new Error(`Namespace ${namespace} is not writable by this Agent`);
      if (body.metadata !== undefined && (!body.metadata || typeof body.metadata !== 'object' || Array.isArray(body.metadata))) throw new RuntimeError('invalid_input', 'Artifact metadata must be an object');
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      return text(JSON.stringify(await input.artifacts!.publish({
        ...(typeof body.graphId === 'string' ? { graphId: body.graphId.trim() } : {}),
        namespace,
        ...(body.metadata ? { metadata: body.metadata as Record<string, unknown> } : {}),
        name: String(body.name),
        ...(typeof body.sourcePath === 'string' && body.sourcePath.trim() ? { sourcePath: body.sourcePath } : {}),
        ...(typeof body.content === 'string' ? { content: body.content } : {}),
        ...(typeof body.mediaType === 'string' && body.mediaType.trim() ? { mediaType: body.mediaType.trim() } : {}),
        ...(typeof body.schema === 'string' && body.schema.trim() ? { schema: body.schema.trim() } : {}),
        ...(typeof body.title === 'string' && body.title.trim() ? { title: body.title.trim() } : {}),
        ...(typeof body.summary === 'string' && body.summary.trim() ? { summary: body.summary.trim() } : {}),
        ...(tags ? { tags } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        requestId: String(body.requestId),
      })));
    },
    artifact_retire: async (_id: string, params: unknown) => {
      const body = fields(params);
      return text(JSON.stringify(input.artifacts!.retire(
        String(body.artifactId),
        Number(body.version),
        String(body.reason),
        String(body.requestId),
      )));
    },
    artifact_promote: async (_id: string, params: unknown) => {
      const body = fields(params);
      return text(JSON.stringify(await input.artifacts!.promote!({
        artifactId: String(body.artifactId),
        version: Number(body.version),
        requestId: String(body.requestId),
      })));
    },
    run_command: async (_id, params, signal) => {
      const body = fields(params);
      const result = await input.run!(String(body.command), Array.isArray(body.args) ? body.args.map(String) : [], signal);
      return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
    },
    git: async (_id, params, signal) => {
      const body = fields(params);
      const subcommand = String(body.subcommand ?? '').trim();
      if (!GIT_READ_SUBCOMMANDS.includes(subcommand)) throw new Error(`Only read-only git subcommands: ${GIT_READ_SUBCOMMANDS.join(', ')}`);
      const raw = Array.isArray(body.args) ? body.args : [];
      const args = raw.map(value => String(value));
      if (args.some(value => value.length > 200 || /[\0\r\n]/.test(value))) throw new Error('Invalid git argument');
      if (args.some(value => value === '--output' || value.startsWith('--exec') || value.startsWith('--no-index'))) throw new Error('Unsupported git argument');
      const path = typeof body.path === 'string' ? body.path.trim() : '';
      if (path && (path.startsWith('-') || /[\0\r\n]/.test(path))) throw new Error('Invalid git path');
      const base = [subcommand, ...args];
      const full = await gitText(path ? [...base, '--', path] : base, signal);
      if (full.length <= GIT_OUTPUT_LIMIT) return text(full);
      const summary = await gitText(path ? [subcommand, '--stat', ...args, '--', path] : [subcommand, '--stat', ...args], signal);
      return text(`output exceeded ${GIT_OUTPUT_LIMIT} characters; --stat summary follows\n\n${summary.slice(0, GIT_OUTPUT_LIMIT)}`);
    },
    fetch: async (_id, params, signal) => text(JSON.stringify(await input.fetch!(String(fields(params).url), signal))),
    propose_graph: async (_id: string, params: unknown) => {
      const body = fields(params);
      const proposal = nativeProposal(body.proposal);
      // A version number is a place in the user's history: the default is an
      // in-place edit of the current unconfirmed draft, and only newVersion keeps
      // a separate version.
      const receipt = await input.supervisor!.propose(proposal, String(body.requestId), { newVersion: body.newVersion === true });
      return text(JSON.stringify(receipt));
    },
    withdraw_draft: async (_id: string, params: unknown) => {
      const body = fields(params);
      const receipt = await input.supervisor!.withdrawDraft!({
        proposalVersion: Number(body.proposalVersion),
        reason: String(body.reason ?? ''),
        requestId: String(body.requestId),
      });
      return text(JSON.stringify(receipt));
    },
    confirm_draft: async (_id: string, params: unknown) => {
      const body = fields(params);
      // The confirmation card is a mechanism gate, not a judgement gate: the
      // user's own words are the authorisation, so they are required here and
      // passed through verbatim for the command log.
      const instruction = String(body.instruction ?? '').trim();
      if (!instruction) throw new RuntimeError('invalid_input', 'An instruction is required: record the words that authorised this confirmation');
      const receipt = await input.supervisor!.confirmDraft!({
        proposalVersion: Number(body.proposalVersion),
        draftRevision: Number(body.draftRevision),
        targetBranch: String(body.targetBranch ?? ''),
        instruction,
        requestId: String(body.requestId),
      });
      return text(JSON.stringify(receipt));
    },
    archive_draft: async (_id: string, params: unknown) => {
      const body = fields(params);
      const receipt = await input.supervisor!.archiveDraft!({
        proposalVersion: Number(body.proposalVersion),
        requestId: String(body.requestId),
      });
      return text(JSON.stringify(receipt));
    },
    restore_draft: async (_id: string, params: unknown) => {
      const body = fields(params);
      const receipt = await input.supervisor!.restoreDraft!({
        proposalVersion: Number(body.proposalVersion),
        requestId: String(body.requestId),
      });
      return text(JSON.stringify(receipt));
    },
    delete_draft: async (_id: string, params: unknown) => {
      const body = fields(params);
      const receipt = await input.supervisor!.deleteDraft!({
        proposalVersion: Number(body.proposalVersion),
        requestId: String(body.requestId),
      });
      return text(JSON.stringify(receipt));
    },
    validate_proposal: async (_id: string, params: unknown) => {
      try {
        return text(JSON.stringify(await input.supervisor!.validateProposal!(nativeProposal(fields(params).proposal))));
      } catch (error) {
        const failure = error as Error & { code?: string };
        return text(JSON.stringify({
          valid: false,
          error: {
            code: failure.code ?? 'invalid_proposal',
            message: failure.message,
          },
        }));
      }
    },
    get_graph_state: async () => text(JSON.stringify(await input.supervisor!.graphState!())),
    get_task_status: async (_id: string, params: unknown) => {
      const body = fields(params);
      const optional = (key: string) => typeof body[key] === 'string' && (body[key] as string).trim() ? (body[key] as string).trim() : undefined;
      const taskId = optional('taskId');
      const nodeId = optional('nodeId');
      const waitForNode = optional('waitForNode');
      const timeoutMs = typeof body.timeoutMs === 'number' && Number.isFinite(body.timeoutMs) ? Math.trunc(body.timeoutMs) : undefined;
      return text(JSON.stringify(await input.supervisor!.taskStatus!({
        ...(taskId ? { taskId } : {}), ...(nodeId ? { nodeId } : {}),
        ...(waitForNode ? { waitForNode } : {}), ...(timeoutMs === undefined ? {} : { timeoutMs }),
      })));
    },
    list_projects: async () => text(JSON.stringify(await input.supervisor!.listProjects!())),
    bind_project: async (_id: string, params: unknown) => {
      const body = fields(params);
      return text(JSON.stringify(await input.supervisor!.bindProject!({
        projectId: String(body.projectId).trim(),
        requestId: String(body.requestId).trim(),
      })));
    },
    list_problems: async () => text(JSON.stringify(await input.supervisor!.listProblems!())),
    list_human_checks: async () => text(JSON.stringify(await input.supervisor!.pendingHumanChecks!())),
    review_human_check: async (_id: string, params: unknown) => {
      const body = fields(params);
      if (typeof body.approve !== 'boolean') {
        throw new Error('review_human_check requires approve as a boolean');
      }
      return text(JSON.stringify(await input.supervisor!.reviewHumanCheck!({
        questionId: String(body.questionId).trim(),
        approve: body.approve,
        note: String(body.note ?? '').trim(),
        requestId: String(body.requestId).trim(),
      })));
    },
    resolve_problem: async (_id: string, params: unknown) => {
      const body = fields(params);
      const action = String(body.action).trim();
      if (!['retry', 'acknowledge', 'respond', 'reconcile_usage', 'escalate'].includes(action)) {
        throw new Error('Unsupported problem action');
      }
      const response = typeof body.response === 'string' ? body.response.trim() : undefined;
      const proof = typeof body.proof === 'string' ? body.proof.trim() : undefined;
      return text(JSON.stringify(await input.supervisor!.resolveProblem!({
        questionId: String(body.questionId).trim(),
        action: action as 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate',
        ...(response ? { response } : {}),
        ...(proof ? { proof } : {}),
        requestId: String(body.requestId).trim(),
      })));
    },
    search_resources: async (_id, params) => {
      const body = fields(params);
      const query = typeof body.query === 'string' ? body.query.trim() : '';
      if (query.length > 500) throw new Error('Capability search query must be at most 500 characters');
      const kind = typeof body.kind === 'string' && body.kind.trim() ? body.kind.trim() : undefined;
      if (kind && !['skill', 'mcp', 'extension', 'pi-extension', 'prompt'].includes(kind)) throw new Error('Unsupported capability kind');
      const role = typeof body.role === 'string' && body.role.trim() ? body.role.trim() : undefined;
      if (role && role !== 'agent' && role !== 'tool') throw new Error('Prompt role must be agent or tool');
      const result = input.catalog!.searchCapabilities({
        ...(query ? { query } : {}),
        ...(kind ? { kind: kind as CapabilityRecord['kind'] } : {}),
        ...(role ? { role: role as 'agent' | 'tool' } : {}),
        ...(typeof body.limit === 'number' ? { limit: body.limit } : {}),
        ...(typeof body.offset === 'number' ? { offset: body.offset } : {}),
      });
      return text(JSON.stringify({ ...result, items: result.items.map(capabilityView) }));
    },
    get_resource: async (_id, params) => {
      const body = fields(params);
      const { id, version } = resourceReference(body.id, body.version);
      if (!id || id.length > 160) throw new Error('A bounded resource id is required');
      const entry = input.catalog!.capability(id, version);
      if (!entry) {
        const recipe = input.catalog!.agentCombination(id);
        const hint = recipe
          ? ` "${id}" is an Agent recipe id; use get_agent_combination instead.`
          : ' Use the exact id and version returned by search_resources.';
        throw new Error(`Unknown capability ${id}${version ? `@${version}` : ''}.${hint}`);
      }
      return text(JSON.stringify(capabilityView(entry)));
    },
    read_system_capabilities: async () => text(JSON.stringify(await input.systemContext!.systemSummary!())),
    inspect_graph_system: async () => text(JSON.stringify(await input.systemContext!.systemDiagnostics!())),
    propose_system_change: async (_id, params) => {
      const body = fields(params);
      const title = String(body.title).trim();
      const problem = String(body.problem).trim();
      const impact = typeof body.impact === 'string' ? body.impact.trim() : undefined;
      const risk = typeof body.risk === 'string' ? body.risk.trim() : undefined;
      if (!title || title.length > 200) throw new Error('A system-change title of at most 200 characters is required');
      if (!problem || problem.length > 4_000) throw new Error('A concrete problem statement of at most 4000 characters is required');
      if (impact && impact.length > 2_000) throw new Error('System-change impact must be at most 2000 characters');
      if (risk && risk.length > 2_000) throw new Error('System-change risk must be at most 2000 characters');
      const serialized = String(body.changeJson);
      if (!serialized.trim() || serialized.length > 250_000) throw new Error('changeJson must be a bounded JSON document');
      const change = JSON.parse(serialized) as Json;
      if (!change || typeof change !== 'object' || Array.isArray(change)) throw new Error('changeJson must describe one object');
      return text(JSON.stringify(await input.systemContext!.proposeSystemChange!({
        title,
        problem,
        change,
        ...(impact ? { impact } : {}),
        ...(risk ? { risk } : {}),
      })));
    },
    apply_system_change: async (_id, params) => {
      const proposalId = String(fields(params).proposalId).trim();
      if (!proposalId || proposalId.length > 200) throw new Error('A bounded proposalId is required');
      return text(JSON.stringify(await input.systemContext!.applySystemChange!(proposalId)));
    },
    inspect_rsi_status: async () => text(JSON.stringify(await input.systemContext!.rsiStatus!())),
    apply_rsi_change: async (_id, params) => {
      const body = fields(params);
      const title = String(body.title ?? '').trim();
      const problem = String(body.problem ?? '').trim();
      if (!title || title.length > 200) throw new Error('An RSI title of at most 200 characters is required');
      if (!problem || problem.length > 4_000) throw new Error('A concrete RSI problem of at most 4000 characters is required');
      const receipt = await input.systemContext!.rsiApply!(params);
      return { ...text(JSON.stringify(receipt)), ...(receipt.status === 'applied' && receipt.restartRequired === true ? { terminate: true } : {}) };
    },
    ask_user: async (_id, params) => {
      const body = fields(params);
      const prompt = String(body.prompt ?? '').trim();
      const why = String(body.why ?? '').trim();
      if (!prompt) throw new Error('A question is required');
      if (!why) throw new Error('Say what would change with the answer: a question nobody can act on is not worth the user turn');
      if (!input.onAskUser) throw new Error('This Agent session cannot ask the user');
      const options = Array.isArray(body.options) ? [...new Set(body.options.map(value => String(value).trim()).filter(Boolean))].slice(0, 8).map(value => value.slice(0, 300)) : [];
      input.onAskUser({ prompt: prompt.slice(0, 2_000), why: why.slice(0, 1_000), options, multiple: body.multiple === true });
      // The turn stops here on purpose: the answer is the next turn's input, so continuing
      // would spend model requests on work the answer may invalidate.
      return { ...text(JSON.stringify({ status: 'asked', prompt })), terminate: true };
    },
    conversation_read: async (_id, params) => {
      const body = fields(params);
      if (!input.conversations) throw new Error('This Agent session cannot reach other conversations');
      const action = String(body.action ?? '').trim();
      const bounded = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
      if (action === 'list') {
        return text(JSON.stringify(await input.conversations.list({ ...(body.archived === true ? { archived: true } : {}) })));
      }
      const conversationId = String(body.conversationId ?? '').trim();
      if (!conversationId) throw new Error('conversationId is required for read and follow');
      if (action === 'read') {
        return text(JSON.stringify(await input.conversations.read(conversationId, { limit: bounded(body.limit, 50), after: bounded(body.after, 0) })));
      }
      if (action === 'follow') {
        return text(JSON.stringify(await input.conversations.follow(conversationId, bounded(body.after, 0), bounded(body.limit, 100))));
      }
      throw new Error('Unsupported read action: use list, read or follow');
    },
    conversation_write: async (_id, params) => {
      const body = fields(params);
      if (!input.conversations) throw new Error('This Agent session cannot reach other conversations');
      const action = String(body.action ?? '').trim();
      const conversationId = String(body.conversationId ?? '').trim();
      const requestId = String(body.requestId ?? '').trim();
      if (!conversationId) throw new Error('conversationId is required');
      if (!requestId) throw new Error('A bounded requestId is required');
      if (action === 'send' || action === 'steer') {
        const message = String(body.text ?? '').trim();
        if (!message) throw new Error(`text is required for ${action}`);
        const receipt = action === 'send'
          ? await input.conversations.send({ conversationId, text: message, requestId })
          : await input.conversations.steer({ conversationId, text: message, requestId });
        return text(JSON.stringify(receipt));
      }
      if (action === 'pause') return text(JSON.stringify(await input.conversations.pause({ conversationId, requestId })));
      if (action === 'resume') return text(JSON.stringify(await input.conversations.resume({ conversationId, requestId })));
      throw new Error('Unsupported write action: use send, steer, pause or resume');
    },
    control_task: async (_id, params) => {
      const body = fields(params);
      const action = String(body.action ?? '').trim();
      if (!['pause', 'resume', 'abandon', 'set_budget', 'steer'].includes(action)) {
        throw new Error('Unsupported control action: use pause, resume, abandon, set_budget or steer');
      }
      if (!input.supervisor?.controlTask) throw new Error('This Agent session cannot control tasks');
      const requestId = String(body.requestId ?? '').trim();
      if (!requestId) throw new Error('A bounded requestId is required');
      const receipt = await input.supervisor.controlTask({
        action: action as 'pause' | 'resume' | 'abandon' | 'set_budget' | 'steer',
        ...(typeof body.taskId === 'string' && body.taskId.trim() ? { taskId: body.taskId.trim() } : {}),
        ...(typeof body.nodeId === 'string' && body.nodeId.trim() ? { nodeId: body.nodeId.trim() } : {}),
        ...(typeof body.text === 'string' ? { text: body.text } : {}),
        ...(body.tokens === null ? { tokens: null } : typeof body.tokens === 'number' ? { tokens: body.tokens } : {}),
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        requestId,
      });
      // Abandoning ends the task, so there is nothing left to continue in this turn.
      return { ...text(JSON.stringify(receipt)), ...(action === 'abandon' ? { terminate: true } : {}) };
    },
    list_peers: async () => {
      if (!input.peers) throw new Error('This Agent session has no graph peers');
      return text(JSON.stringify({ peers: await input.peers.list() }));
    },
    send_to_peer: async (_id, params) => {
      if (!input.peers) throw new Error('This Agent session has no graph peers');
      const body = fields(params);
      const to = String(body.to ?? '').trim();
      const message = String(body.text ?? '').trim();
      const requestId = String(body.requestId ?? '').trim();
      if (!to) throw new Error('to is required: name a peer node id (list_peers shows them)');
      if (!message) throw new Error('text is required');
      if (!requestId) throw new Error('A bounded requestId is required');
      return text(JSON.stringify(await input.peers.send({ to, text: message, requestId })));
    },
    list_agent_combinations: async (_id, params) => {
      const body = fields(params);
      const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : '';
      if (query.length > 200) throw new Error('Agent combination query must be at most 200 characters');
      const grade = typeof body.grade === 'string' ? body.grade.trim() : '';
      if (grade && !MODEL_GRADES.includes(grade as ModelGrade)) throw new Error('Unsupported model grade');
      const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0 ? Math.min(Math.floor(body.limit), 50) : 30;
      return text(JSON.stringify(input.catalog!.searchAgentCombinations({
        ...(query ? { query } : {}),
        ...(grade ? { grade: grade as ModelGrade } : {}),
        limit,
      })));
    },
    get_agent_combination: async (_id, params) => {
      const id = String(fields(params).id).trim();
      if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
      const combination = input.catalog!.agentCombination(id);
      if (!combination) throw new Error(`Unknown Agent combination ${id}`);
      return text(JSON.stringify(combination));
    },
  };

  const descriptions = describeAgentTools({
    graphManagement: Boolean(input.supervisor?.graphCreate),
    graphRead: Boolean(input.readGraph),
    workspaceCommit: Boolean(input.commitWorkspace),
    ...(input.role ? { role: input.role } : {}),
    readOnly: Boolean(input.readOnly),
    run: Boolean(input.run),
    fetch: Boolean(input.fetch),
    catalog: Boolean(input.catalog),
    ...(input.artifacts ? { artifacts: {
      allowedNamespaces: input.artifacts.allowedNamespaces,
      canPromote: input.artifacts.canPromote,
    } } : {}),
    ...(input.supervisor ? { supervisor: {
      validateProposal: Boolean(input.supervisor.validateProposal),
      graphState: Boolean(input.supervisor.graphState),
      taskStatus: Boolean(input.supervisor.taskStatus),
      listProjects: Boolean(input.supervisor.listProjects),
      bindProject: Boolean(input.supervisor.bindProject),
      withdrawDraft: Boolean(input.supervisor.withdrawDraft),
      confirmDraft: Boolean(input.supervisor.confirmDraft),
      archiveDraft: Boolean(input.supervisor.archiveDraft),
      restoreDraft: Boolean(input.supervisor.restoreDraft),
      deleteDraft: Boolean(input.supervisor.deleteDraft),
      listProblems: Boolean(input.supervisor.listProblems),
      resolveProblem: Boolean(input.supervisor.resolveProblem),
      pendingHumanChecks: Boolean(input.supervisor.pendingHumanChecks && input.supervisor.reviewHumanCheck),
      reviewHumanCheck: Boolean(input.supervisor.pendingHumanChecks && input.supervisor.reviewHumanCheck),
      controlTask: Boolean(input.supervisor.controlTask),
    } } : {}),
    ...(input.conversations ? { conversations: { read: true, write: true } } : {}),
    // The peer tools exist only for a graph node that was actually given the channel, so the
    // declaration and the handler never disagree.
    ...(input.peers ? { peers: true } : {}),
    ...(input.systemContext ? { systemContext: {
      systemSummary: Boolean(input.systemContext.systemSummary),
      systemDiagnostics: Boolean(input.systemContext.systemDiagnostics),
      proposeSystemChange: Boolean(input.systemContext.proposeSystemChange),
      applySystemChange: Boolean(input.systemContext.applySystemChange),
    } } : {}),
    ...(input.systemContext?.rsiStatus || input.systemContext?.rsiApply ? { rsi: {
      status: Boolean(input.systemContext.rsiStatus),
      apply: Boolean(input.systemContext.rsiApply),
    } } : {}),
  });
  return descriptions.map(({ available: _available, externallyGated: hostGated, ...declaration }) => {
    const tool = { ...declaration, execute: handlers[declaration.name] };
    return hostGated ? externallyGated(tool) : tool;
  });
}
