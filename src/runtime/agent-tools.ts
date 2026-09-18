import { realpathSync } from 'node:fs';
import { isAbsolute, sep } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CapabilityRecord, Catalog } from '../catalog/catalog.ts';
import type { AgentCombination } from '../catalog/agent-combinations.ts';
import type { Json, NodeSpec, Proposal } from '../core/types.ts';
import { listBounded, readBounded, writeBounded } from './bounded-path.ts';
import { externallyGated } from './pi-instance.ts';

type Supervisor = {
  propose(proposal: Proposal, requestId: string): Promise<unknown>;
  revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
  listProblems?(): Promise<unknown>;
  resolveProblem?(input: {
    questionId: string;
    action: 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage';
    response?: string;
    proof?: string;
    requestId: string;
  }): Promise<unknown>;
};

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }], details: {} };
}

function fields(params: unknown) {
  return params as Record<string, unknown>;
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
  /** Discussion turns investigate without writing business files or running commands. */
  readOnly?: boolean;
  run?: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;
  fetch?: (url: string) => Promise<{ url: string; status: number; contentType: string; text: string; truncated: boolean }>;
  supervisor?: Supervisor;
  catalog?: Catalog;
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
    requestModelAccess?: (input: { modelId: string; reason: string; planId?: string }) => Promise<Record<string, unknown>>;
  };
  onSubmit?: (output: Json) => void;
  onSuggestedPrompt?: (prompt: string) => void;
}): ToolDefinition[] {
  const root = realpathSync(input.workspace);
  const readRoots = (input.readRoots ?? []).map(item => realpathSync(item));
  const tools: ToolDefinition[] = [
    {
      name: 'read', label: 'Read file', description: 'Read a UTF-8 file from the instance workspace or a bound capability.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => {
        const requested = String(fields(params).path);
        if (isAbsolute(requested)) {
          const mount = [root, ...readRoots].find(candidate => requested === candidate || requested.startsWith(`${candidate}${sep}`));
          if (!mount) throw new Error('Path is outside the workspace');
          return text(await readBounded(mount, requested));
        }
        return text(await readBounded(root, requested));
      },
    },
    ...(input.readOnly ? [] : [{
      name: 'write_file', label: 'Write file', description: 'Write a UTF-8 file inside the instance workspace.',
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_id: string, params: unknown) => {
        const body = fields(params);
        await writeBounded(root, String(body.path), String(body.content));
        return text(`Wrote ${body.path}`);
      },
    }]),
    {
      name: 'list_dir', label: 'List directory', description: 'List files in a workspace directory.',
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_id, params) => text((await listBounded(root, String(fields(params).path || '.'))).join('\n')),
    },
    {
      name: 'submit_result', label: 'Submit result', description: 'Submit structured JSON output for this operation.',
      parameters: Type.Object({ outputJson: Type.String() }),
      execute: async (_id, params) => {
        input.onSubmit?.(JSON.parse(String(fields(params).outputJson)) as Json);
        return text('Recorded structured result');
      },
    },
  ];
  if (input.run && !input.readOnly) {
    const run = input.run;
    tools.push(externallyGated({
      name: 'run_command', label: 'Run command', description: 'Run an allowed command inside the work copy: command is a bare executable name (node or git) and args is a string array, for example {command:"node",args:["--test","test/x.test.js"]}. It is not a shell; git only supports read-only status/diff/log/show.',
      parameters: Type.Object({ command: Type.String(), args: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, params) => {
        const body = fields(params);
        const result = await run(String(body.command), Array.isArray(body.args) ? body.args.map(String) : []);
        return text(`exit ${result.code ?? 'signal'}\n${result.stdout}${result.stderr}`);
      },
    }));
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
        name: 'suggest_prompt', label: 'Suggest next prompt', description: 'Record one concise next user prompt to show as an optional composer suggestion. This never sends anything automatically and must not replace the normal reply.',
        parameters: Type.Object({ prompt: Type.String() }),
        execute: async (_id: string, params: unknown) => {
          const prompt = String(fields(params).prompt).trim();
          if (!prompt || prompt.length > 500) throw new Error('A prompt suggestion must be between 1 and 500 characters');
          input.onSuggestedPrompt?.(prompt);
          return text('Recorded prompt suggestion');
        },
      },
      {
        name: 'propose_graph', label: 'Propose graph', description: 'Submit a validated task graph proposal for the user to confirm. proposalJson must use the schema shown in the briefing. Keep the optional decisions list current: it is frozen with this draft version and passed to workers after confirmation.',
        parameters: Type.Object({ proposalJson: Type.String(), requestId: Type.String() }),
        execute: async (_id: string, params: unknown) => {
          const body = fields(params);
          const proposal = JSON.parse(String(body.proposalJson)) as Proposal;
          const receipt = await input.supervisor!.propose(proposal, String(body.requestId));
          return text(JSON.stringify(receipt));
        },
      },
      {
        name: 'revise_graph', label: 'Revise graph', description: 'Revise the confirmed task graph without changing acceptance items. nodesJson uses the same node schema shown in the briefing.',
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
      ...(input.supervisor.listProblems && input.supervisor.resolveProblem ? [{
        name: 'list_problems', label: 'List execution problems', description: 'List internal execution problems currently owned by the main Agent. These are not user questions; inspect them before retrying, revising the graph, or asking the user for a real decision.',
        parameters: Type.Object({}),
        execute: async () => text(JSON.stringify(await input.supervisor!.listProblems!())),
      }, {
        name: 'resolve_problem', label: 'Resolve execution problem', description: 'Resolve one main-Agent-owned execution problem after diagnosis. Use retry for transient execution/context failures, acknowledge only when the obstacle is externally cleared, respond when the worker asked a question, and reconcile_usage only when the provider cannot supply authoritative usage and the rationale is recorded.',
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
          if (!['retry', 'acknowledge', 'respond', 'reconcile_usage'].includes(action)) {
            throw new Error('Unsupported problem action');
          }
          const response = typeof body.response === 'string' ? body.response.trim() : undefined;
          const proof = typeof body.proof === 'string' ? body.proof.trim() : undefined;
          return text(JSON.stringify(await input.supervisor!.resolveProblem!({
            questionId: String(body.questionId).trim(),
            action: action as 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage',
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
      name: 'search_resources', label: 'Search capability library', description: 'Search the user capability directory (Skills, MCP servers, Pi extensions, Graph extensions and prompt identities). These entries are available immediately from disk; a capability does not grant task permission.',
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
        name: 'get_resource', label: 'Get capability details', description: 'Read one capability from the user capability directory by id or id@version. It is immediately loadable, but still grants no task permission.',
        parameters: Type.Object({ id: Type.String(), version: Type.Optional(Type.String()) }),
        execute: async (_id, params) => {
          const body = fields(params);
          const id = String(body.id).trim();
          if (!id || id.length > 160) throw new Error('A bounded resource id is required');
          const version = typeof body.version === 'string' && body.version.trim() ? body.version.trim() : undefined;
          const entry = input.catalog!.capability(id, version);
          if (!entry) throw new Error(`Unknown capability ${id}${version ? `@${version}` : ''}`);
          return text(JSON.stringify(capabilityView(entry)));
        },
      },
    );
  }
  if (input.role === 'master' && input.systemContext?.systemSummary) {
    tools.push({
      name: 'read_system_capabilities', label: 'Read system capabilities', description: 'Read a redacted inventory of configured subscription plans, model connections, Agent definitions, graph architectures and quota windows. Secret values are never included. Use this before choosing a model, assembling subagents or claiming that something is available.',
      parameters: Type.Object({}),
      execute: async () => text(JSON.stringify(await input.systemContext!.systemSummary!())),
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
        name: 'save_agent_combination', label: 'Save Agent combination', description: 'Create or edit an Agent recipe. A recipe may reference only capabilities that already exist in the user capability directory; it never creates capabilities or grants permission.',
        parameters: Type.Object({ combinationJson: Type.String() }),
        execute: async (_id, params) => {
          const combination = JSON.parse(String(fields(params).combinationJson)) as AgentCombination;
          const saved = await input.catalog!.saveAgentCombination(combination);
          return text(JSON.stringify(saved));
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
      {
        name: 'compile_agent_combination', label: 'Compile Agent combination', description: 'Validate and compile a recipe into a versioned Agent definition. Put the returned definitionVersion directly into propose_graph; no manual definition authoring is required.',
        parameters: Type.Object({ id: Type.String() }),
        execute: async (_id, params) => {
          const id = String(fields(params).id).trim();
          if (!id || id.length > 160) throw new Error('A bounded Agent combination id is required');
          return text(JSON.stringify(input.catalog!.compileAgentCombination(id)));
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
