import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { describeAgentTools, type AgentToolFeatures } from './agent-tool-definitions.ts';
import {
  DEFAULT_COMMON_RULES, DEFAULT_MAIN_FULL_ACCESS_IDENTITY, DEFAULT_MAIN_RULES,
  DEFAULT_MAIN_RSI_IDENTITY, DEFAULT_MAIN_TOOL_GUIDANCE, DEFAULT_REVIEWER_RULES, DEFAULT_REVIEWER_TOOL_GUIDANCE,
  DEFAULT_WORKER_RULES, DEFAULT_WORKER_TOOL_GUIDANCE, DEFAULT_WORKER_PROMPT, DEFAULT_NODE_PROMPT,
  renderAgentPrompt, type AgentContextLibrary,
} from './agent-context.ts';
import { graphDocumentationPaths } from './agent-docs.ts';
import {
  composeAgentSystemPrompt, type AgentCapabilityPromptEntry, type AgentToolPromptEntry,
} from './agent-system-prompt.ts';
import { capabilityPrompts, type CapabilityLoadFact } from './capabilities.ts';
import { openCapabilityBundle, type CapabilityBundleOptions, type CapabilityOperation } from './capability-bundle.ts';
import { agentSkills } from './agent-skills.ts';
import { piNativeToolNamesForPlatform, piNativeToolPromptEntries, selectAgentToolSurface } from './pi-native-tools.ts';

export interface AgentContextTool extends Omit<AgentToolPromptEntry, 'version'> {
  version: string | null;
  capabilityId: string | null;
  enabled: boolean;
  runtimeAvailable: boolean | null;
}

/** Local context is read once; opening it never starts an MCP or Pi process. */
export interface AgentContextAssemblyOptions extends CapabilityBundleOptions {
  action: string;
  runtime?: 'node' | 'worker';
  role?: string;
  workspace: string | null;
  library?: AgentContextLibrary;
  fullAccess?: boolean;
  retrieval?: boolean;
  /** The Main Agent may change this Graph checkout through the RSI tools. */
  rsi?: boolean;
}

async function projectInstructions(workspace: string | null) {
  if (!workspace) return undefined;
  for (const name of ['AGENTS.override.md', 'AGENTS.md', 'AGENTS.MD', 'CLAUDE.md', 'CLAUDE.MD']) {
    const path = join(workspace, name);
    try {
      const content = await readFile(path, 'utf8');
      if (content.trim()) return { path, content };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return undefined;
}

function parameters(schema: unknown): string[] {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return [];
  const properties = (schema as { properties?: unknown }).properties;
  return properties && typeof properties === 'object' && !Array.isArray(properties)
    ? Object.keys(properties).sort() : [];
}

function permission(name: string) {
  if (name === 'read' || name === 'list_dir') return 'workspace and granted read roots';
  if (name === 'write_file') return 'workspace write';
  if (name === 'run_command') return 'host-gated command policy';
  if (name === 'fetch') return 'declared network domains';
  if (name.startsWith('artifact_')) return 'task artifact workspace';
  if (name === 'propose_graph' || name === 'graph_patch') return 'task graph control';
  if (name === 'validate_proposal' || name === 'get_graph_state' || name === 'get_task_status') return 'current conversation graph';
  if (name === 'list_projects' || name === 'bind_project') return 'configured project binding';
  if (name.startsWith('git_')) return 'read-only work copy Git';
  if (name === 'apply_system_change' || name === 'propose_system_change') return 'user-approved system change';
  if (name === 'inspect_rsi_status' || name === 'apply_rsi_change') return 'Graph source checkout (self-improvement)';
  return 'Graph call gate and current access policy';
}

function hostTool(tool: Pick<ToolDefinition, 'name' | 'description' | 'parameters'>): AgentContextTool {
  return {
    name: tool.name, description: tool.description, parameters: parameters(tool.parameters),
    source: 'Graph', version: null, capabilityId: null, permission: permission(tool.name),
    enabled: true, available: true, runtimeAvailable: true,
  };
}

function nativeTools(names: readonly string[]): AgentContextTool[] {
  return piNativeToolPromptEntries(names).map(tool => ({
    ...tool, version: null, capabilityId: null, enabled: true, runtimeAvailable: true,
  }));
}

function loadedTools(operation: CapabilityOperation): AgentContextTool[] {
  const owners = new Map<string, CapabilityLoadFact>();
  for (const fact of operation.report) for (const name of fact.tools ?? []) owners.set(name, fact);
  const tools = operation.tools.map(tool => {
    const owner = owners.get(tool.name);
    return {
      ...hostTool(tool), source: owner?.name ?? owner?.id ?? 'Graph',
      version: owner?.version ?? null, capabilityId: owner?.id ?? null,
    };
  });
  const present = new Set(tools.map(tool => tool.name));
  for (const fact of operation.report) {
    if (fact.kind !== 'pi-extension') continue;
    for (const name of fact.tools ?? []) {
      if (present.has(name)) continue;
      present.add(name);
      tools.push({
        name, description: fact.reason ?? `Registered by Pi extension ${fact.name ?? fact.id}.`,
        source: fact.name ?? fact.id, version: fact.version, capabilityId: fact.id,
        parameters: [], permission: 'bound Pi extension tool', enabled: true,
        available: fact.loaded && fact.executable, runtimeAvailable: fact.loaded && fact.executable,
      });
    }
  }
  return [...nativeTools(operation.nativeTools), ...tools];
}

function loadedCapabilities(report: readonly CapabilityLoadFact[]): AgentCapabilityPromptEntry[] {
  return report.map(fact => ({
    id: fact.id, version: fact.version, kind: fact.kind ?? 'capability', name: fact.name ?? fact.id,
    ...(fact.description ? { description: fact.description } : {}),
    tools: [...(fact.tools ?? [])],
    ...(fact.path ? { path: fact.path } : {}),
    ...(fact.networkDomains?.length ? { networkDomains: [...fact.networkDomains] } : {}),
    ...(fact.reason ? { reason: fact.reason } : {}),
  }));
}

export async function openAgentContextAssembly(input: AgentContextAssemblyOptions) {
  const workspace = input.workspace ? await realpath(input.workspace) : null;
  const role = input.role === 'master' ? 'main' : input.action.toLowerCase().includes('review') ? 'reviewer' : 'worker';
  const definitionId = input.definitionVersion?.split('@')[0];
  const definitionExists = input.definitionVersion && input.catalog.hasDefinition(input.definitionVersion);
  const inlinePrompt = definitionExists ? input.catalog.definition(input.definitionVersion!).systemPrompt : undefined;
  const identityOverride = !inlinePrompt && input.library && definitionId
    ? await input.library.agentPrompt(definitionId, input.bootstrap?.agent ?? null) : undefined;
  const bootstrap = {
    ...(inlinePrompt?.trim() ? { agent: inlinePrompt } : identityOverride?.trim() ? { agent: identityOverride } : input.bootstrap?.agent ? { agent: input.bootstrap.agent } : {}),
    ...(input.bootstrap?.tool ? { tool: input.bootstrap.tool } : {}),
  };
  const bundle = await openCapabilityBundle({
    catalog: input.catalog,
    ...(input.definitionVersion ? { definitionVersion: input.definitionVersion } : {}),
    bootstrap,
    ...(input.mcpDomains ? { mcpDomains: input.mcpDomains } : {}),
    ...(input.secrets ? { secrets: input.secrets } : {}),
    ...(input.skillFolder ? { skillFolder: input.skillFolder } : {}),
    ...(input.skillOwnedRoots?.length ? { skillOwnedRoots: input.skillOwnedRoots } : {}),
    ...(workspace ? { skillCwd: workspace } : {}),
    ...(input.skillProjectRoot ? { skillProjectRoot: input.skillProjectRoot } : {}),
  });
  const retrievalNote = input.retrieval ? ' The fetch tool reads HTTP documents from granted domains.' : '';
  const [common, roleRules, toolGuidance, runtime, projectContext, disabledTools] = await Promise.all([
    input.library?.prompt('rules/common.md') ?? DEFAULT_COMMON_RULES,
    input.library?.prompt(`rules/${role}.md`) ?? (role === 'main' ? DEFAULT_MAIN_RULES : role === 'reviewer' ? DEFAULT_REVIEWER_RULES : DEFAULT_WORKER_RULES),
    input.library?.prompt(`tools/${role}.md`) ?? input.bootstrap?.tool
      ?? (role === 'main' ? DEFAULT_MAIN_TOOL_GUIDANCE : role === 'reviewer' ? DEFAULT_REVIEWER_TOOL_GUIDANCE : DEFAULT_WORKER_TOOL_GUIDANCE),
    role === 'main' ? undefined : input.runtime === 'node'
      ? input.library?.prompt('runtime/node.md') ?? DEFAULT_NODE_PROMPT
      : input.library?.prompt('runtime/worker.md', { retrievalNote }) ?? renderAgentPrompt(DEFAULT_WORKER_PROMPT, { retrievalNote }),
    projectInstructions(workspace),
    role === 'main' && input.library ? input.library.disabledTools() : [],
  ]);
  const docs = graphDocumentationPaths();
  const definitionVersion = input.definitionVersion ?? 'unknown@1';
  const compose = (identity: string, tools: AgentContextTool[], capabilities: AgentCapabilityPromptEntry[]) => {
    const composed = composeAgentSystemPrompt({
      identity, definitionVersion, toolGuidance, role,
      ...(input.fullAccess && role === 'main' ? { identityContext: DEFAULT_MAIN_FULL_ACCESS_IDENTITY } : {}),
      ...(input.rsi && role === 'main' ? { harnessContext: DEFAULT_MAIN_RSI_IDENTITY } : {}),
      rules: { common, role: roleRules, ...(runtime === undefined ? {} : { runtime }) },
      docs,
    });
    return { tools, capabilities, composed, docsRoot: docs.root };
  };
  return {
    bundle,
    disabledTools,
    /** Actual operation facts remain authoritative; no settings are re-read here. */
    forOperation(operation: CapabilityOperation) {
      return compose(operation.prompts.system, loadedTools(operation), loadedCapabilities(operation.report));
    },
    /** Next-operation configuration only. Historical load reports do not enter this projection. */
    async preview(features: AgentToolFeatures) {
      const declared: AgentContextTool[] = [];
      const capabilities: AgentCapabilityPromptEntry[] = [];
      let identity = bootstrap.agent ?? null;
      for (const fact of bundle.facts) {
        const record = input.catalog.capability(fact.id, fact.version);
        if (fact.role === 'agent') identity = await readFile(fact.path, 'utf8');
        const name = record?.name ?? fact.id;
        const tools = fact.declaredTools ?? [];
        capabilities.push({
          id: fact.id, version: fact.version, kind: fact.kind, name,
          ...(record?.description ? { description: record.description } : {}),
          path: fact.path, tools: tools.map(tool => tool.name),
          ...(fact.networkDomains?.length ? { networkDomains: [...fact.networkDomains] } : {}),
          reason: 'Declared for the next operation; runtime availability has not been confirmed.',
        });
        for (const tool of tools) declared.push({
          name: tool.name, description: tool.description, parameters: [], source: name,
          version: fact.version, capabilityId: fact.id, permission: 'definition-bound capability',
          enabled: true, available: true, runtimeAvailable: null,
        });
      }
      const all = [...describeAgentTools(features).map(hostTool), ...declared];
      const requestedNative = piNativeToolNamesForPlatform();
      const selected = selectAgentToolSurface({ tools: all, nativeTools: requestedNative, disabledTools });
      const enabled = new Set([...selected.nativeTools, ...selected.tools.map(tool => tool.name)]);
      // Include disabled declarations so the settings panel can re-enable them;
      // use the same replacement policy as the actual operation for every name.
      const disabled = new Set(disabledTools);
      const visible = selectAgentToolSurface({ tools: all, nativeTools: selected.nativeTools }).tools;
      const unique = new Map([...visible, ...nativeTools(requestedNative)].map(tool => [tool.name, tool]));
      const tools = [...unique.values()].map(tool => ({
        ...tool, enabled: !disabled.has(tool.name), available: enabled.has(tool.name),
      })).sort((left, right) => left.name.localeCompare(right.name));
      // The next-operation view carries facts only: what a send really composes is
      // asserted where it is produced, in the provider request.
      return { tools, capabilities, docsRoot: docs.root };
    },
  };
}
