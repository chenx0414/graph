import { realpathSync } from 'node:fs';
import { extname, isAbsolute, sep } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
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

type Supervisor = {
  propose(proposal: Proposal, requestId: string): Promise<unknown>;
  revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
  graphState?(): Promise<unknown>;
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
  const tools: ToolDefinition[] = [
    {
      name: 'read', label: 'Read file', description: 'Read a UTF-8 file or supported image from the instance workspace or a bound capability.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
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
    },
    ...(input.readOnly ? [] : [{
      name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the instance workspace.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const body = fields(params);
        const requested = String(body.path);
        if (hostWrite && isAbsolute(requested)) await writeHost(requested, String(body.content), pathOptions);
        else await writeBounded(root, requested, String(body.content));
        return text(`Wrote ${body.path}`);
      },
    }]),
    {
      name: 'list_dir', label: 'List directory', description: 'List files in a workspace directory or a permitted read-only capability directory.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const requested = String(fields(params).path || '.');
        if (isAbsolute(requested)) {
          if (hostRead) return text((await listHost(requested, pathOptions)).join('\n'));
          const mount = [root, ...readRoots].find(candidate => requested === candidate || requested.startsWith(`${candidate}${sep}`));
          if (!mount) throw new Error('Path is outside the workspace');
          return text((await listBounded(mount, requested)).join('\n'));
        }
        return text((await listBounded(root, requested)).join('\n'));
      },
    },
    ...(input.artifacts ? [{
      name: 'artifact_list',
      label: 'List shared artifacts',
      description: 'List published task artifacts. This is the discovery surface for literature sets, plans, review reports and deliverables; it returns metadata only. Use artifact_read for bounded content.',
      parameters: Type.Object({
        namespace: Type.Optional(Type.String()),
        prefix: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String()),
        tag: Type.Optional(Type.String()),
        trust: Type.Optional(Type.String()),
        includeRetired: Type.Optional(Type.Boolean()),
        latestOnly: Type.Optional(Type.Boolean()),
        limit: Type.Optional(Type.Number()),
        cursor: Type.Optional(Type.String()),
      }),
      execute: async (_id: string, params: unknown) => {
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
    }, {
      name: 'artifact_read',
      label: 'Read shared artifact',
      description: 'Read one immutable artifact by artifactId. Omit version to read the latest published version, which is useful for discovery but must not be treated as a frozen reference; text is returned within maxBytes, while binary content returns its immutable read-only path and metadata.',
      parameters: Type.Object({
        artifactId: Type.String(),
        version: Type.Optional(Type.Number()),
        maxBytes: Type.Optional(Type.Number()),
      }),
      execute: async (_id: string, params: unknown) => {
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
    }, {
      name: 'artifact_publish',
      label: 'Publish shared artifact',
      description: `Publish an immutable artifact version from a file inside this Agent's private workspace or from direct text content. Allowed namespaces: ${input.artifacts.allowedNamespaces.join(', ')}. Publishing never overwrites an earlier version; use expectedVersion for compare-and-swap.`,
      parameters: Type.Object({
        namespace: Type.String(),
        name: Type.String(),
        sourcePath: Type.Optional(Type.String()),
        content: Type.Optional(Type.String()),
        mediaType: Type.Optional(Type.String()),
        schema: Type.Optional(Type.String()),
        title: Type.Optional(Type.String()),
        summary: Type.Optional(Type.String()),
        tags: Type.Optional(Type.Array(Type.String())),
        expectedVersion: Type.Optional(Type.Number()),
        requestId: Type.String(),
      }),
      execute: async (_id: string, params: unknown) => {
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
    }, ...(input.artifacts.canPromote ? [{
      name: 'artifact_retire',
      label: 'Retire shared artifact version',
      description: 'Retire one published artifact version without deleting its immutable bytes. Use only when a version is superseded or withdrawn; existing evidence and handoff references remain explainable.',
      parameters: Type.Object({ artifactId: Type.String(), version: Type.Number(), reason: Type.String(), requestId: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const body = fields(params);
        return text(JSON.stringify(input.artifacts!.retire(
          String(body.artifactId),
          Number(body.version),
          String(body.reason),
          String(body.requestId),
        )));
      },
    }, {
      name: 'artifact_promote',
      label: 'Promote artifact to project knowledge',
      description: 'Explicitly promote one exact task artifact version into project-scoped shared knowledge for future tasks in the same project. This does not mutate or retire the source version.',
      parameters: Type.Object({ artifactId: Type.String(), version: Type.Number(), requestId: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const body = fields(params);
        return text(JSON.stringify(await input.artifacts!.promote!({
          artifactId: String(body.artifactId),
          version: Number(body.version),
          requestId: String(body.requestId),
        })));
      },
    }] : [])] : []),
  ];
  if (input.role !== 'master') tools.push({
      name: 'submit_result', label: 'Submit result', description: 'Submit structured JSON output for this operation.',
      parameters: Type.Object({ outputJson: Type.String() }),
      execute: async (_id, params) => {
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
    });
  if (input.run && !input.readOnly) {
    const run = input.run;
    const runGit = async (args: string[]) => {
      const result = await run('git', args);
      return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
    };
    tools.push(externallyGated({
      name: 'run_command', label: 'Run command', description: 'Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:"node",args:["--test","test/x.test.js"]}. It is not a shell; git only supports read-only status/diff/log/show.',
      parameters: Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => {
        const body = fields(params);
        const result = await run(String(body.command), Array.isArray(body.args) ? body.args.map(String) : []);
        return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
      },
    }));
    tools.push(
      externallyGated({
        name: 'git_status', label: 'Git status', description: 'Read the current work copy branch and working-tree status. This is read-only.',
        parameters: Type.Object({}),
        execute: async () => runGit(['status', '--short', '--branch']),
      }),
      externallyGated({
        name: 'git_diff', label: 'Git diff', description: 'Read the current work copy diff. Optionally select staged changes, a base revision, a path or summary/stat output. This is read-only.',
        parameters: Type.Object({
          staged: Type.Optional(Type.Boolean()),
          base: Type.Optional(Type.String()),
          path: Type.Optional(Type.String()),
          stat: Type.Optional(Type.Boolean()),
        }),
        execute: async (_id: string, params: unknown) => {
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
      }),
      externallyGated({
        name: 'git_log', label: 'Git log', description: 'Read recent commits from the current work copy. This is read-only.',
        parameters: Type.Object({
          limit: Type.Optional(Type.Number()),
          path: Type.Optional(Type.String()),
        }),
        execute: async (_id: string, params: unknown) => {
          const body = fields(params);
          const limit = typeof body.limit === 'number' && Number.isFinite(body.limit) && body.limit > 0
            ? Math.min(Math.floor(body.limit), 100)
            : 20;
          const args = ['log', '-n', String(limit), '--oneline'];
          const path = typeof body.path === 'string' ? body.path.trim() : '';
          if (path) args.push('--', path);
          return runGit(args);
        },
      }),
      externallyGated({
        name: 'git_show', label: 'Git show', description: 'Read one commit or object from the current work copy. Optionally request summary/stat output or limit to one path. This is read-only.',
        parameters: Type.Object({
          ref: Type.Optional(Type.String()),
          stat: Type.Optional(Type.Boolean()),
          path: Type.Optional(Type.String()),
        }),
        execute: async (_id: string, params: unknown) => {
          const body = fields(params);
          const ref = typeof body.ref === 'string' && body.ref.trim() ? body.ref.trim() : 'HEAD';
          if (ref.startsWith('-') || ref.length > 200 || /[\0\r\n]/.test(ref)) throw new Error('Invalid Git ref');
          const args = ['show', ref];
          if (body.stat === true) args.push('--stat');
          const path = typeof body.path === 'string' ? body.path.trim() : '';
          if (path) args.push('--', path);
          return runGit(args);
        },
      }),
    );
  }
  if (input.fetch) {
    const fetchUrl = input.fetch;
    tools.push(externallyGated({
      name: 'fetch', label: 'Fetch URL', description: 'Fetch a text document from a granted domain and return its body.',
      parameters: Type.Object({ url: Type.String() }),
      execute: async (_id, params) => text(JSON.stringify(await fetchUrl(String(fields(params).url)))),
    }));
  }
  if (input.role === 'master' && input.supervisor) {
    tools.push(
      {
        name: 'propose_graph', label: 'Propose graph', description: 'Submit a validated task graph proposal for the user to confirm. proposalJson is a JSON object with requirementVersion, summary, acceptance[{id,description,checkNode}], nodes[NodeSpec], optional containers, loops and decisions. Agent nodes require definitionVersion and model; every acceptance checkNode must reference a mandatory program node. Keep decisions current: they are frozen with this draft version and passed to workers after confirmation.',
        parameters: Type.Object({ proposalJson: Type.String(), requestId: Type.String() }),
        execute: async (_id: string, params: unknown) => {
          const body = fields(params);
          const proposal = JSON.parse(String(body.proposalJson)) as Proposal;
          const receipt = await input.supervisor!.propose(proposal, String(body.requestId));
          return text(JSON.stringify(receipt));
        },
      },
      {
        name: 'revise_graph', label: 'Revise graph', description: 'Revise the confirmed task graph without changing acceptance items. nodesJson is a JSON array of NodeSpec objects using id, kind, action, dependsOn, input, definitionVersion, model, context and verifier fields as applicable.',
        parameters: Type.Object({ baseVersion: Type.Number(), reason: Type.String(), nodesJson: Type.String(), requestId: Type.String() }),
        execute: async (_id, params) => {
          const body = fields(params);
          const receipt = await input.supervisor!.revise({
            baseVersion: Number(body.baseVersion), reason: String(body.reason),
            nodes: JSON.parse(String(body.nodesJson)) as NodeSpec[], requestId: String(body.requestId),
          });
          return text(JSON.stringify(receipt));
        },
      },
      ...(input.supervisor.validateProposal ? [{
        name: 'validate_proposal', label: 'Validate graph proposal', description: 'Validate one task graph proposal against the current requirement version and Graph structural rules without creating a draft or dispatching work. Returns valid:true or a concrete validation error.',
        parameters: Type.Object({ proposalJson: Type.String() }),
        execute: async (_id: string, params: unknown) => {
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
      }] : []),
      ...(input.supervisor.graphState ? [{
        name: 'get_graph_state', label: 'Get graph state', description: 'Read the current proposal, graph revision, phase, node statuses, evidence, worktrees and internal problems for this conversation. Use this instead of guessing progress from chat history or the injected briefing.',
        parameters: Type.Object({}),
        execute: async () => text(JSON.stringify(await input.supervisor!.graphState!())),
      }] : []),
      ...(input.supervisor.listProjects ? [{
        name: 'list_projects', label: 'List projects', description: 'List the projects currently configured in Graph, including their preparation state. Use this before asking the user to choose a project.',
        parameters: Type.Object({}),
        execute: async () => text(JSON.stringify(await input.supervisor!.listProjects!())),
      }] : []),
      ...(input.supervisor.bindProject ? [{
        name: 'bind_project', label: 'Bind project', description: 'Bind this conversation to one configured and prepared project. Binding a different project invalidates the current graph draft and requires a fresh investigation.',
        parameters: Type.Object({ projectId: Type.String(), requestId: Type.String() }),
        execute: async (_id: string, params: unknown) => {
          const body = fields(params);
          return text(JSON.stringify(await input.supervisor!.bindProject!({
            projectId: String(body.projectId).trim(),
            requestId: String(body.requestId).trim(),
          })));
        },
      }] : []),
      ...(input.supervisor.listProblems && input.supervisor.resolveProblem ? [{
        name: 'list_problems', label: 'List execution problems', description: 'List internal execution problems currently owned by the main Agent. These are not user questions; inspect them before retrying, revising the graph, or asking the user for a real decision.',
        parameters: Type.Object({}),
        execute: async () => text(JSON.stringify(await input.supervisor!.listProblems!())),
      }, {
        name: 'resolve_problem', label: 'Resolve execution problem', description: 'Resolve one main-Agent-owned execution problem after diagnosis. Use retry for transient execution/context failures and for a result_noncompliant problem whose defects you can correct by re-asking the worker (the worker is told what is missing and does not redo the work); acknowledge only when the obstacle is externally cleared; respond when the worker asked a question; reconcile_usage only when the provider cannot supply authoritative usage and the rationale is recorded; escalate when the defect needs a decision only the user can make - that resolves your problem and opens a user question with your explanation attached, so the user answer becomes part of the next attempt.',
        parameters: Type.Object({
          questionId: Type.String(),
          action: Type.String(),
          response: Type.Optional(Type.String()),
          proof: Type.Optional(Type.String()),
          requestId: Type.String(),
        }),
        execute: async (_id: string, params: unknown) => {
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
      }] : []),
    );
  }
  if (input.role === 'master' && input.catalog) {
    tools.push({
      name: 'search_resources', label: 'Search capability library', description: 'Search the user capability directory (Skills, MCP servers, Pi extensions, Graph extensions and prompt identities). Search results are discovery only; bind a capability into a versioned Agent recipe or definition to make its tools available to that Agent.',
      parameters: Type.Object({
        query: Type.Optional(Type.String()),
        kind: Type.Optional(Type.String()),
        role: Type.Optional(Type.String()),
        limit: Type.Optional(Type.Number()),
        offset: Type.Optional(Type.Number()),
      }),
      execute: async (_id, params) => {
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
    });
    tools.push(
      {
        name: 'get_resource', label: 'Get capability details', description: 'Read one capability returned by search_resources by id or id@version. This never reads Agent recipes or definitions; use get_agent_combination with the recipe id (for example coder, not coder@5). Reading details does not bind the capability.',
        parameters: Type.Object({ id: Type.String(), version: Type.Optional(Type.String()) }),
        execute: async (_id, params) => {
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
      },
    );
  }
  if (input.role === 'master' && input.systemContext?.systemSummary) {
    tools.push({
      name: 'read_system_capabilities', label: 'Read system capabilities', description: 'Read configuration inventory: redacted subscription plans, model connections, current Agent recipes, compiled Agent definitions, graph architectures and quota windows. Secret values are never included. Use this before choosing a model, assembling subagents or claiming that something is available.',
      parameters: Type.Object({}),
      execute: async () => text(JSON.stringify(await input.systemContext!.systemSummary!())),
    });
  }
  if (input.role === 'master' && input.systemContext?.systemDiagnostics) {
    tools.push({
      name: 'inspect_graph_system', label: 'Inspect Graph health', description: 'Inspect runtime health for this conversation only: invalid capabilities, open internal problems, failed nodes, unknown-usage records, artifact counts and pending system changes. Configuration inventories are returned by read_system_capabilities, not duplicated here.',
      parameters: Type.Object({}),
      execute: async () => text(JSON.stringify(await input.systemContext!.systemDiagnostics!())),
    });
  }
  if (input.role === 'master' && input.systemContext?.proposeSystemChange) {
    tools.push({
      name: 'propose_system_change', label: 'Propose system change', description: 'Propose a Graph system optimization for explicit user approval. This does not change configuration. Include the exact machine-readable change. Supported change.kind is currently "capability" with change.capability = { manifest, files?, overwrite? }. Use it when the user asks to install/update a capability or when diagnostics reveal a system defect.',
      parameters: Type.Object({
        title: Type.String(),
        problem: Type.String(),
        changeJson: Type.String(),
        impact: Type.Optional(Type.String()),
        risk: Type.Optional(Type.String()),
      }),
      execute: async (_id, params) => {
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
    });
  }
  if (input.role === 'master' && input.systemContext?.applySystemChange) {
    tools.push({
      name: 'apply_system_change', label: 'Apply approved system change', description: 'Apply one previously proposed system change only after the user approved its system_change question. Approval and proposal data are checked by the host; this tool cannot bypass the user decision.',
      parameters: Type.Object({ proposalId: Type.String() }),
      execute: async (_id, params) => {
        const proposalId = String(fields(params).proposalId).trim();
        if (!proposalId || proposalId.length > 200) throw new Error('A bounded proposalId is required');
        return text(JSON.stringify(await input.systemContext!.applySystemChange!(proposalId)));
      },
    });
  }
  if (input.role === 'master' && input.catalog) {
    tools.push(
      {
        name: 'list_agent_combinations', label: 'List Agent combinations', description: 'List subagent recipes composed from shared resource-library IDs. Results are recipes, not installed definitions or permissions; inspect the referenced resources before using one.',
        parameters: Type.Object({
          query: Type.Optional(Type.String()),
          grade: Type.Optional(Type.String()),
          limit: Type.Optional(Type.Number()),
        }),
        execute: async (_id, params) => {
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
      },
      {
        name: 'get_agent_combination', label: 'Get Agent combination', description: 'Resolve one subagent recipe to its source resources. This does not install, compose or authorize anything; use the returned resources and their metadata to prepare the required capabilities.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => {
          const id = String(fields(params).id).trim();
          if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
          const combination = input.catalog!.agentCombination(id);
          if (!combination) throw new Error(`Unknown Agent combination ${id}`);
          return text(JSON.stringify(combination));
        },
      },
      {
        name: 'save_agent_combination', label: 'Save and compile Agent combination', description: 'Create or edit an Agent recipe, then validate and compile it immediately into a versioned Agent definition. A recipe may reference only capabilities that already exist; saving never creates capabilities or grants permission. Use the returned definitionVersion directly in propose_graph.',
        parameters: Type.Object({ combinationJson: Type.String() }),
        execute: async (_id, params) => {
          const combination = JSON.parse(String(fields(params).combinationJson)) as AgentCombination;
          const saved = await input.catalog!.saveAgentCombination(combination);
          const compiled = input.catalog!.compileAgentCombination(combination.id);
          return text(JSON.stringify({ combination: saved, definition: compiled }));
        },
      },
      {
        name: 'delete_agent_combination', label: 'Delete Agent combination', description: 'Delete one user-editable Agent recipe. This never removes referenced capabilities.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => {
          const id = String(fields(params).id).trim();
          if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
          return text(JSON.stringify(await input.catalog!.deleteAgentCombination(id)));
        },
      },
    );
  }
  if (input.role === 'master' && input.systemContext?.requestModelAccess) {
    tools.push({
      name: 'request_model_access', label: 'Request model access', description: 'Open one durable user question asking for a model or subscription to be configured. This never edits configuration and never grants permission automatically. Use it only when the current task needs a model that read_system_capabilities shows as unavailable.',
      parameters: Type.Object({ modelId: Type.String(), reason: Type.String(), planId: Type.Optional(Type.String()) }),
      execute: async (_id, params) => {
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
    });
  }
  return tools;
}
