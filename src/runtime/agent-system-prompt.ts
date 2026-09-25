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
  | 'skills'
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
  /** Text a capability itself contributes about using it (its tool.md). */
  capabilityDocs?: string;
  /**
   * The skills block rendered by the SDK's own formatter (`formatSkillsForPrompt`),
   * passed through verbatim so skills keep the native shape.
   */
  skills?: string;
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

export function composeAgentSystemPrompt(input: ComposeAgentSystemPromptInput): ComposedAgentSystemPrompt {
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
    {
      id: 'rules.tools',
      title: 'Tool guidance',
      origin: 'editable',
      content: input.toolGuidance,
      source: 'tools/<role>.md',
    },
    {
      id: 'rules.send_gate',
      title: 'Send gate',
      origin: 'generated',
      content: 'Use only the tools listed in the provider request. Every model, command, MCP and extension call passes the Graph send gate; a blocked call is not retried by inventing another route.',
    },
    ...(input.role === 'main' ? [] : [{
      id: 'rules.worktree',
      title: 'Worktree',
      origin: 'generated' as const,
      content: "This directory is this operation's own Git worktree: relative paths resolve here, and it is neither necessarily the project root nor another Agent's worktree.",
    }]),
  ]);

  const docs = section('docs', 'Documentation', [{
    id: 'docs.guide',
    title: 'Graph documentation and reading protocol',
    origin: 'generated',
    content: graphDocumentationPrompt(input.docs),
    source: 'docs/agent/README.md',
  }]);

  const identity = section('identity', 'Identity', [
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
  ]);

  // Native concerns are never rendered here: the Pi SDK appends the project
  // context, its own skills block and the working directory to this text, and
  // the provider request carries the tools.
  const sections = [identity, rules, docs];
  const text = sections.map(renderedSection).join('\n\n');
  return { sections, text };
}
