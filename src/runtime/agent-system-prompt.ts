import { AGENT_TESTING_POLICY } from './agent-testing-policy.ts';
import { graphDocumentationPrompt, type GraphDocumentationPaths } from './agent-docs.ts';

export type AgentPromptOrigin = 'editable' | 'generated' | 'pi';

export interface AgentPromptPart {
  id: string;
  title: string;
  origin: AgentPromptOrigin;
  content: string;
  source?: string;
}

/**
 * The sections Graph itself renders into the system prompt. Identity, rules and docs are
 * the whole list: tool declarations and capabilities travel outside the prompt text (the
 * agent loop puts them on the system message as `toolsAdded`, and the provider adapters
 * fold them into the request `tools`), so no section of this kind exists. Pi appends its
 * own native blocks (project context, skills, cwd) after Graph's text.
 */
export type AgentPromptSectionId =
  | 'identity'
  | 'rules'
  | 'docs';

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

/**
 * The composer renders only what Graph itself owns: the identity, the rules and
 * the documentation paths. Tools travel in the provider request, and the Pi
 * session adds the project context, its skills block and the working directory,
 * so none of them is an input here.
 */
export interface ComposeAgentSystemPromptInput {
  identity: string;
  identityContext?: string;
  harnessContext?: string;
  definitionVersion: string;
  toolGuidance: string;
  rules: {
    common: string;
    role: string;
    runtime?: string;
  };
  docs: GraphDocumentationPaths;
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
      id: 'rules.host',
      title: 'Host rules',
      origin: 'generated' as const,
      content: [AGENT_TESTING_POLICY, ...(input.role === 'main' ? [] : ["This directory is this operation's own Git worktree: relative paths resolve here, and it is neither necessarily the project root nor another Agent's worktree."])].join('\n\n'),
    },
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
