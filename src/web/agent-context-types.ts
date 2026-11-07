type PromptOrigin = 'editable' | 'generated' | 'pi';

export interface AgentPromptPartView {
  id: string;
  title: string;
  origin: PromptOrigin;
  content: string;
  source?: string;
}

export interface AgentPromptSectionView {
  id: string;
  title: string;
  parts: AgentPromptPartView[];
}

export interface AgentPromptView {
  key: string;
  title: string;
  description: string;
  group: 'identity' | 'tools' | 'rules' | 'runtime';
  file: string;
  content: string;
  defaultContent: string;
  customized: boolean;
  defaultCustomized: boolean;
}

export interface AgentToolView {
  name: string;
  description: string;
  source: string;
  version: string | null;
  capabilityId: string | null;
  parameters: string[];
  permission: string;
  enabled: boolean;
  available: boolean;
  runtimeAvailable: boolean | null;
}

export interface AgentCapabilityView {
  id: string;
  version: string;
  kind: string;
  name: string;
  description?: string;
  tools: string[];
  networkDomains?: string[];
  reason?: string;
}

export interface AgentContextView {
  root: string;
  definitionVersion: string | null;
  latestDefinitionVersion: string | null;
  prompts: AgentPromptView[];
  disabledTools: string[];
  tools: AgentToolView[];
  capabilities: AgentCapabilityView[];
  preview: {
    sections: AgentPromptSectionView[];
    text: string;
  };
  /** The exact system prompt the newest master turn sent, recorded at the provider call. */
  sent: { operationId: string; at: number; text: string; tools: string | null } | null;
}
