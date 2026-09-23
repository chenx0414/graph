import { realpathSync } from 'node:fs';
import { extname, isAbsolute, sep } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityRecord, Catalog } from '../catalog/catalog.ts';
import type { AgentCombination } from '../catalog/agent-combinations.ts';
import type { Json, NodeSpec, Proposal } from '../core/types.ts';
import { isHostRead, isHostWrite, type ResolvedAccessPolicy } from '../core/access-policy.ts';
import type { ArtifactPage, ArtifactRecord, ArtifactTrust, PublishArtifactInput } from '../core/artifact-workspace.ts';
import {
  listBounded, listHost, readBounded, readBoundedBytes, readHost, readHostBytes, writeBounded, writeHost,
} from './bounded-path.ts';
import { externallyGated } from './pi-instance.ts';
import { describeAgentTools, type AgentToolName } from './agent-tool-definitions.ts';

type Supervisor = {
  propose(proposal: Proposal, requestId: string): Promise<unknown>;
  revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; retire?: string[]; requestId: string }): Promise<unknown>;
  graphState?(): Promise<unknown>;
  taskStatus?(input: { taskId?: string; nodeId?: string; waitForNode?: string; timeoutMs?: number }): Promise<unknown>;
  validateProposal?(proposal: Proposal): Promise<unknown>;
  listProjects?(): Promise<unknown>;
  bindProject?(input: { projectId: string; requestId: string }): Promise<unknown>;
  listProblems?(): Promise<unknown>;
  resolveProblem?(input: {
    questionId: string;
    action: 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate';
    response?: string;
    proof?: string;
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
  publish(input: Omit<PublishArtifactInput, 'taskId' | 'workspace' | 'producer'>): Promise<ArtifactRecord>;
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
  role?: NodeSpec['role'];
  readRoots?: string[];
  access?: ResolvedAccessPolicy;
  /** Discussion turns investigate without writing business files or running commands. */
  readOnly?: boolean;
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  fetch?: (url: string) => Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }>;
  supervisor?: Supervisor;
  catalog?: Catalog;
  artifacts?: ArtifactToolService;
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    systemDiagnostics?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    proposeSystemChange?: (input: { title: string; problem: string; change: Json; impact?: string; risk?: string }) => Promise<Record<string, unknown>>;
    applySystemChange?: (proposalId: string) => Promise<Record<string, unknown>>;
    requestModelAccess?: (input: { modelId: string; reason: string; planId?: string }) => Promise<Record<string, unknown>>;
    rsiStatus?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    rsiApply?: (input: unknown) => Promise<Record<string, unknown>>;
  };
  onSubmit?: (output: Json) => void;
  /**
   * Reject a submission the harness cannot use, in the worker's own field
   * coordinates, so it can be corrected inside the same turn instead of being
   * discovered after the operation ended.
   */
  validateSubmission?: (output: Json) => { ok: true } | { ok: false; defects: { path: string; class: string; expected: string; got: string }[] };
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
  const runGit = async (args: string[]) => {
    const result = await input.run!('git', args);
    return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
  };
  const handlers: Record<AgentToolName, ToolDefinition['execute']> = {
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
    write_file: async (_id: string, params: unknown) => {
      const body = fields(params);
      const requested = String(body.path);
      if (hostWrite && isAbsolute(requested)) await writeHost(requested, String(body.content), pathOptions);
      else await writeBounded(root, requested, String(body.content));
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
    artifact_publish: async (_id: string, params: unknown) => {
      const body = fields(params);
      const namespace = String(body.namespace).trim();
      if (!input.artifacts!.allowedNamespaces.includes(namespace)) throw new Error(`Namespace ${namespace} is not writable by this Agent`);
      const tags = Array.isArray(body.tags) ? body.tags.map(String) : undefined;
      const expectedVersion = typeof body.expectedVersion === 'number' ? body.expectedVersion : undefined;
      return text(JSON.stringify(await input.artifacts!.publish({
        namespace,
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
    submit_result: async (_id, params) => {
      const output = JSON.parse(String(fields(params).outputJson)) as Json;
      const verdict = input.validateSubmission?.(output);
      if (verdict && !verdict.ok) {
        throw new Error([
          'submit_result refused: the harness cannot use this result yet.',
          ...verdict.defects.map(defect => `- ${defect.path} (${defect.class}): expected ${defect.expected}; got ${defect.got}`),
          'Correct these fields and call submit_result again with the same work. Do not redo or rewrite the implementation; whatever you already wrote stays in place.',
        ].join('\n'));
      }
      input.onSubmit?.(output);
      return text('Recorded structured result');
    },
    run_command: async (_id, params) => {
      const body = fields(params);
      const result = await input.run!(String(body.command), Array.isArray(body.args) ? body.args.map(String) : []);
      return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
    },
    git_status: async () => runGit(['status', '--short', '--branch']),
    git_diff: async (_id: string, params: unknown) => {
      const body = fields(params);
      const args = ['diff'];
      if (body.staged === true) args.push('--staged');
      if (body.stat === true) args.push('--stat');
      const base = typeof body.base === 'string' ? body.base.trim() : '';
      if (base) {
        if (base.startsWith('-') || base.length > 200 || /[\0\r\n]/.test(base)) throw new Error('Invalid Git base revision');
        args.push(base);
      }
      const path = typeof body.path === 'string' ? body.path.trim() : '';
      if (path) args.push('--', path);
      return runGit(args);
    },
    git_log: async (_id: string, params: unknown) => {
      const body = fields(params);
      const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
        ? Math.min(Math.floor(body.limit), 100)
        : 20;
      const args = ['log', '-n', String(limit), '--oneline'];
      const path = typeof body.path === 'string' ? body.path.trim() : '';
      if (path) args.push('--', path);
      return runGit(args);
    },
    git_show: async (_id: string, params: unknown) => {
      const body = fields(params);
      const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : 'HEAD';
      if (ref.startsWith('-') || ref.length > 200 || /[\0\r\n]/.test(ref)) throw new Error('Invalid Git ref');
      const args = ['show', ref];
      if (body.stat === true) args.push('--stat');
      const path = typeof body.path === 'string' ? body.path.trim() : '';
      if (path) args.push('--', path);
      return runGit(args);
    },
    fetch: async (_id, params) => text(JSON.stringify(await input.fetch!(String(fields(params).url)))),
    propose_graph: async (_id: string, params: unknown) => {
      const body = fields(params);
      const proposal = JSON.parse(String(body.proposalJson)) as Proposal;
      const receipt = await input.supervisor!.propose(proposal, String(body.requestId));
      return text(JSON.stringify(receipt));
    },
    revise_graph: async (_id, params) => {
      const body = fields(params);
      const receipt = await input.supervisor!.revise({
        baseVersion: Number(body.baseVersion), reason: String(body.reason),
        nodes: JSON.parse(String(body.nodesJson)) as NodeSpec[], requestId: String(body.requestId),
        ...(Array.isArray(body.retire) ? { retire: body.retire.map(String) } : {}),
        ...(typeof body.taskId === 'string' && body.taskId.trim() ? { taskId: body.taskId.trim() } : {}),
      });
      return text(JSON.stringify(receipt));
    },
    validate_proposal: async (_id: string, params: unknown) => {
      try {
        const proposal = JSON.parse(String(fields(params).proposalJson)) as Proposal;
        return text(JSON.stringify(await input.supervisor!.validateProposal!(proposal)));
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
    list_agent_combinations: async (_id, params) => {
      const body = fields(params);
      const query = typeof body.query === 'string' ? body.query.trim().toLowerCase() : '';
      if (query.length > 200) throw new Error('Agent combination query must be at most 200 characters');
      const grade = typeof body.grade === 'string' ? body.grade.trim() : '';
      if (grade && !['low', 'medium', 'high', 'highest'].includes(grade)) throw new Error('Unsupported model grade');
      const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0 ? Math.min(Math.floor(body.limit), 50) : 30;
      return text(JSON.stringify(input.catalog!.searchAgentCombinations({
        ...(query ? { query } : {}),
        ...(grade ? { grade: grade as 'low' | 'medium' | 'high' | 'highest' } : {}),
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
    save_agent_combination: async (_id, params) => {
      const combination = JSON.parse(String(fields(params).combinationJson)) as AgentCombination;
      const saved = await input.catalog!.saveAgentCombination(combination);
      const compiled = input.catalog!.compileAgentCombination(combination.id);
      return text(JSON.stringify({ combination: saved, definition: compiled }));
    },
    update_agent_combination_description: async (_id, params) => {
      const body = fields(params);
      const id = String(body.id).trim();
      const description = String(body.description).trim();
      if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
      if (!description || description.length > 2_000) throw new Error('A nonempty description of at most 2000 characters is required');
      return text(JSON.stringify(await input.catalog!.updateAgentCombinationDescription(id, description)));
    },
    delete_agent_combination: async (_id, params) => {
      const id = String(fields(params).id).trim();
      if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
      return text(JSON.stringify(await input.catalog!.deleteAgentCombination(id)));
    },
    request_model_access: async (_id, params) => {
      const body = fields(params);
      const modelId = String(body.modelId).trim();
      const reason = String(body.reason).trim();
      if (!modelId || modelId.length > 160) throw new Error('A bounded modelId is required');
      if (!reason || reason.length > 2_000) throw new Error('A concise reason of at most 2000 characters is required');
      const planId = typeof body.planId === 'string' ? body.planId.trim() : '';
      if (planId.length > 160) throw new Error('A bounded planId is required');
      return text(JSON.stringify(await input.systemContext!.requestModelAccess!({
        modelId,
        reason,
        ...(planId ? { planId } : {}),
      })));
    },
  };
  const descriptions = describeAgentTools({
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
      listProblems: Boolean(input.supervisor.listProblems),
      resolveProblem: Boolean(input.supervisor.resolveProblem),
    } } : {}),
    ...(input.systemContext ? { systemContext: {
      systemSummary: Boolean(input.systemContext.systemSummary),
      systemDiagnostics: Boolean(input.systemContext.systemDiagnostics),
      proposeSystemChange: Boolean(input.systemContext.proposeSystemChange),
      applySystemChange: Boolean(input.systemContext.applySystemChange),
      requestModelAccess: Boolean(input.systemContext.requestModelAccess),
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
