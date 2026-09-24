import { graphDocumentationPrompt, type GraphDocumentationPaths } from './agent-docs.ts';

export type AgentPromptOrigin = 'editable' | 'generated' | 'pi';

export interface AgentPromptPart {
  id: string;
  title: string;
  origin: AgentPromptOrigin;
  content: string;
  source?: string;
}

export type AgentPromptSectionId =
  | 'identity'
  | 'tools'
  | 'rules'
  | 'docs'
  | 'project_context'
  | 'capabilities'
  | 'cwd'
  | 'pi_cwd';

export interface AgentPromptSection {
  id: AgentPromptSectionId;
  title: string;
  parts: AgentPromptPart[];
}

export interface AgentToolPromptEntry {
  name: string;
  description: string;
  source: string;
  group?: 'pi_native' | 'graph';
  order?: number;
  version?: string;
  parameters: string[];
  permission: string;
  available: boolean;
  /** Null means declared for a future operation, not discovered at runtime. */
  runtimeAvailable?: boolean | null;
}

export interface AgentCapabilityPromptEntry {
  id: string;
  version: string;
  kind: string;
  name: string;
  description?: string;
  tools: string[];
  path?: string;
  networkDomains?: string[];
  reason?: string;
}

export interface ComposeAgentSystemPromptInput {
  mode?: 'preview' | 'operation';
  identity: string;
  /** Host-generated identity context such as the active access policy. */
  identityContext?: string;
  /** Host-generated context for changing the Graph harness itself. */
  harnessContext?: string;
  definitionVersion: string;
  toolGuidance: string;
  rules: {
    common: string;
    role: string;
    runtime?: string;
  };
  docs: GraphDocumentationPaths;
  projectContext?: {
    path: string;
    content: string;
  };
  tools: AgentToolPromptEntry[];
  capabilities: AgentCapabilityPromptEntry[];
  cwd?: string;
  /** Normalized Agent role: only subagents get the worktree orientation note. */
  role?: 'main' | 'worker' | 'reviewer';
}

export interface ComposedAgentSystemPrompt {
  sections: AgentPromptSection[];
  text: string;
}

function section(
  id: AgentPromptSectionId,
  title: string,
  parts: AgentPromptPart[],
): AgentPromptSection {
  return { id, title, parts: parts.filter(part => part.content.trim()) };
}

function renderedSection(sectionValue: AgentPromptSection) {
  const content = sectionValue.parts
    .map(part => part.content.trim())
    .filter(Boolean)
    .join('\n\n');
  return `<${sectionValue.id}>\n${content}\n</${sectionValue.id}>`;
}

function toolLine(tool: AgentToolPromptEntry) {
  const description = tool.description.replace(/\s+/g, ' ').trim();
  const availability = tool.runtimeAvailable === null ? ' (not yet discovered)' : tool.available ? '' : ' (unavailable)';
  return `- ${tool.name}${availability}: ${description}`;
}

function toolInventory(input: ComposeAgentSystemPromptInput) {
  const native = input.tools
    .filter(tool => tool.group === 'pi_native')
    .sort((left, right) => (left.order ?? 0) - (right.order ?? 0));
  const graph = input.tools
    .filter(tool => tool.group !== 'pi_native')
    .sort((left, right) => left.name.localeCompare(right.name));
  if (!native.length && !graph.length) return '(none)';

  const blocks: string[] = [];
  if (native.length) blocks.push(native.map(toolLine).join('\n'));
  if (graph.length) {
    const transition = native.length
      ? `In addition to the tools above, you may have access to the following Graph tools for ${input.definitionVersion}:`
      : `The following Graph tools are available for ${input.definitionVersion}:`;
    blocks.push([
      transition,
      graph.map(toolLine).join('\n'),
    ].join('\n'));
  }
  return blocks.join('\n\n');
}

function capabilityLines(capabilities: readonly AgentCapabilityPromptEntry[]) {
  if (!capabilities.length) return '(none)';
  return capabilities.map(capability => {
    const tools = capability.tools.length ? `tools=${capability.tools.join(', ')}` : 'tools=none';
    const network = capability.networkDomains?.length
      ? `; network=${capability.networkDomains.join(', ')}`
      : '';
    const path = capability.path ? `; path=${capability.path}` : '';
    const reason = capability.reason ? `; ${capability.reason}` : '';
    const description = capability.description ? `: ${capability.description}` : '';
    return `- ${capability.kind} ${capability.id}@${capability.version} (${capability.name})${description}: ${tools}${network}${path}${reason}`;
  }).join('\n');
}

export function composeAgentSystemPrompt(input: ComposeAgentSystemPromptInput): ComposedAgentSystemPrompt {
  const tools = section('tools', 'Tools', [
    {
      id: 'tools.inventory',
      title: 'Available tools',
      origin: 'generated',
      content: toolInventory(input),
    },
    {
      id: 'tools.guidance',
      title: 'Tool guidance',
      origin: 'editable',
      content: input.toolGuidance,
      source: 'tools/<role>.md',
    },
  ]);

  const rules = section('rules', 'Rules', [
    {
      id: 'rules.common',
      title: 'Common rules',
      origin: 'editable',
      content: input.rules.common,
      source: 'rules/common.md',
    },
    {
      id: 'rules.role',
      title: 'Role rules',
      origin: 'editable',
      content: input.rules.role,
      source: 'rules/<role>.md',
    },
    ...(input.rules.runtime ? [{
      id: 'rules.runtime',
      title: 'Runtime rules',
      origin: 'editable' as const,
      content: input.rules.runtime,
      source: 'runtime/*.md',
    }] : []),
  ]);

  const docs = section('docs', 'Documentation', [{
    id: 'docs.guide',
    title: 'Graph documentation and reading protocol',
    origin: 'generated',
    content: graphDocumentationPrompt(input.docs),
    source: 'docs/agent/README.md',
  }]);

  const projectContext = section('project_context', 'Project context', [{
    id: 'project_context.instructions',
    title: 'Project instructions',
    origin: 'generated',
    content: input.projectContext
      ? [
          'Project-specific instructions and guidelines:',
          '',
          `<project_instructions path="${input.projectContext.path}">`,
          input.projectContext.content.trim(),
          '</project_instructions>',
        ].join('\n')
      : 'No project-specific AGENTS.md or equivalent instruction file was found in this worktree.',
    ...(input.projectContext ? { source: input.projectContext.path } : {}),
  }]);

  const capabilities = section('capabilities', 'Capabilities', [{
    id: 'capabilities.inventory',
    title: input.mode === 'preview' ? 'Declared capabilities' : 'Loaded capabilities',
    origin: 'generated',
    content: [
      input.mode === 'preview'
        ? 'Skills, MCP servers, Graph extensions and Pi extensions declared for the next Agent operation; runtime availability will be confirmed when they load:'
        : 'Skills, MCP servers, Graph extensions and Pi extensions loaded for this Agent operation:',
      capabilityLines(input.capabilities),
    ].join('\n'),
  }]);

  const cwd = section('cwd', 'Working directory', [{
    id: 'cwd.worktree',
    title: 'Git worktree',
    origin: 'generated',
    content: input.cwd === undefined
      ? 'No worktree has been prepared for this conversation yet.'
      : [
        `Current working directory: ${input.cwd}`,
        ...(input.role === 'main' ? [] : [
          '',
          "This directory is this operation's own Git worktree: relative paths resolve here, and it is neither necessarily the project root nor another Agent's worktree.",
        ]),
      ].join('\n'),
  }]);

  const sections = [
    section('identity', 'Identity', [
      {
        id: 'identity.agent',
        title: 'Agent identity',
        origin: 'editable',
        content: input.identity,
        source: 'agents/<definition-id>.md',
      },
      ...(input.identityContext?.trim() ? [{
        id: 'identity.access',
        title: 'Access policy',
        origin: 'generated' as const,
        content: input.identityContext.trim(),
      }] : []),
      ...(input.harnessContext?.trim() ? [{
        id: 'identity.harness',
        title: 'Harness self-improvement',
        origin: 'generated' as const,
        content: input.harnessContext.trim(),
      }] : []),
    ]),
    tools,
    rules,
    docs,
    projectContext,
    capabilities,
    cwd,
  ];
  const text = sections.map(renderedSection).join('\n\n');
  return { sections, text };
}
