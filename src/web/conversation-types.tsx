







import type { ProtocolRef } from '../core/interface-spec.ts';



import {
type ComposerStorage
} from './composer-state.ts';




import {
type ConversationMessage
} from '../core/conversation-projection.ts';


import {
isResidentPanel,
type ConversationDrawerPage
} from './conversation-drawer.ts';

import './conversation-drawer.css';









export type Settings = { projects: { id: string; root: string; branch?: string | null; preparation?: { branch?: string | null } | null }[]; models: { id: string; grade: string; credentialId?: string; reasoning?: boolean; thinkingOptions?: { level: string; label: string }[] }[] };

export type ConversationSummary = {
  id: string; title: string; projectId: string | null; anchorTaskId: string; createdAt: number; updatedAt: number | null;
  openQuestions: number; taskCount: number; status: string;
};

export type ConversationNode = { id: string; kind: string; role: string | null; status: string; used: number | null; budget: number | null; unlimited?: boolean; model: string | null; definitionVersion: string | null; stallCount: number; outputVersion: number };

export type ConversationTask = {
  id: string; request: string; phase: string; status: string; paused: boolean; targetBranch: string | null; createdAt: number;
  acceptedProposalVersion: number | null; integrationSha: string | null;
  openQuestions: { id: string; nodeId: string; kind: string; data: Record<string, unknown>; askedAt?: number | null; waitedMs?: number | null; overdueAfterMs?: number; overdue?: boolean }[];
  nodes: ConversationNode[];
  cost: { unknown?: boolean; amount?: number };
  evidence: { acceptanceId: string; valid: boolean }[];
};

export type GraphAgentDetail = {
  id: string;
  version: number;
  name: string;
  description: string | null;
  recommendedGrade: string;
  review: boolean;
  capabilities: {
    id: string;
    version: string;
    role: string;
    kind: string | null;
    name: string;
    status: string;
    source: string | null;
  }[];
  experience: {
    task: {
      token: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number };
      runMs: { mean: number | null; samples: number; unknown: number; unfinished: number; failed: number };
      totalSamples: number;
    };
    samples: {
      taskId: string; nodeId: string; request: string | null; status: string;
      tokens: number | null; runMs: number | null; reworkRounds: number; failed: boolean;
    }[];
  };
};

export type DraftGraph = {
  nodes: {
    id: string; kind: string; status: string; container?: string;
    action?: string; definitionVersion?: string; model?: string;
    agent?: GraphAgentDetail | null;
    inputs?: Record<string, ProtocolRef>;
    outputs?: Record<string, ProtocolRef>;
  }[];
  interfaces?: { edgeId: string; from: string; to: string; enabled: boolean; protocol: string | null; latest: unknown; deliveries: { id: string; value: unknown; protocol: string; revisionVersion: number; createdAt: number; source?: string; sourceExecutionId?: string | null; artifacts?: { taskId: string; artifactId: string; version: number; digest: string | null }[]; receiver?: { kind: string; state: string; operationId: string | null; reason: string | null } }[] }[];
  containers: { id: string; parent?: string }[];
  loops: { from: string; to: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[]; branches?: { id: string; source: string; target: string; case: string }[] };
};

export type ProposalDetail = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  decisions: string | null;
  spec: import('../core/types.ts').NativeProposal;
  draftRevision?: number;
  draftDigest?: string;
  archived?: boolean;
};

export type ProposalVersion = {
  version: number;
  requirementVersion: number;
  stale: boolean;
  summary: string;
  accepted: boolean;
  draftRevision?: number;
  archived?: boolean;
};

export type DrawerPage = ConversationDrawerPage;

export function residentFlag(id: string): 'true' | undefined {
  return isResidentPanel(id) ? 'true' : undefined;
}

export type AnchorQuestion = { id: string; nodeId: string; operationId: string | null; kind: string; status: string; owner?: string; data: Record<string, unknown>; answer: Record<string, unknown> | null; taskId: string;
  // How long this question has waited for the person who has to answer it.
  // overdueAfterMs is the published deadline; nothing answers the question for you.
  askedAt?: number | null; waitedMs?: number | null; overdueAfterMs?: number; overdue?: boolean };

export type ConversationView = {
  role?: 'global' | 'project' | 'history' | 'legacy';
  eventCursor?: number;
  continuations?: { operationId: string; resumedOperationId: string | null }[];
  id: string; title: string; projectId: string | null; projectRoot: string | null; workspaceProjectId: string; anchorTaskId: string;
  createdAt: number; requirementVersion: number; paused: boolean;
  messages: ConversationMessage[]; messageCount: number;
  streams: {
    operationId: string; entryId: string; partId: string; ordinal: number; text: string; length: number; updatedAt: number;
  }[];
  questions: AnchorQuestion[];
  proposal: ProposalDetail | null;
  proposalHistory: ProposalVersion[];
  archivedProposals: ProposalVersion[];
  accepted: { proposalVersion: number; taskId: string; targetBranch: string; acceptedAt: number }[];
  master: { nodeId: string; status: string; model: string | null; used: number | null; budget: number | null; unlimited?: boolean; definitionVersion: string | null; cost: { unknown?: boolean; amount?: number } } | null;
  cost: { unknown?: boolean; amount?: number };
  usage: { used: number; budget: number | null; unlimited?: boolean };
  telemetry?: {
    model: string | null;
    thinkingLevel: string;
    cacheHitRate: number | null;
    cachedInput: number;
    cacheInput: number;
    contextTokens: number | null;
    contextLimit: number | null;
    contextPercent: number | null;
  };
  tasks: ConversationTask[];
  cursor: number;
};

export const NODE_TONE: Record<string, 'neutral' | 'accent' | 'success' | 'warn' | 'danger' | 'info'> = {
  pending: 'neutral', ready: 'info', preparing: 'accent', running: 'accent',
  succeeded: 'success', failed: 'danger', blocked: 'warn', skipped: 'neutral',
};

export function composerStorage(): ComposerStorage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function sentUserPrompts(messages: ConversationMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    if (message.kind === 'briefing') continue;
    if (message.state === 'queued' || message.state === 'cancelled') continue;
    const text = message.text.trim();
    if (!text) continue;
    if (prompts[prompts.length - 1] === text) continue;
    prompts.push(text);
  }
  return prompts;
}
