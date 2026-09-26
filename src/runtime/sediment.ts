/**
 * Skill sedimentation: the review that runs after an operation and turns a lesson into a skill.
 *
 * Two halves, deliberately separate: deciding whether this operation earned a review, and applying
 * whatever the review proposed. The model only ever produces a document and its metadata; writing to
 * disk happens here, so the guards are structural rather than something the prompt promises to honour.
 */

export interface SedimentGate {
  enabled: boolean;
  role: string | null;
  toolCalls: number;
  threshold: number;
  paused: boolean;
  alreadyReviewed: boolean;
}

export interface SedimentProposal {
  action: 'create' | 'update' | 'nothing';
  id?: string;
  description?: string;
  body?: string;
  reason?: string;
}

export interface SedimentOutcome {
  nothing: boolean;
  written: { id: string; path: string; replaced: boolean }[];
  refused: string[];
}

export function shouldSediment(gate: SedimentGate): boolean {
  void gate;
  return false;
}

export function parseSedimentProposal(text: string): SedimentProposal | null {
  void text;
  return null;
}

export function applySedimentProposal(input: { projectRoot: string; proposal: SedimentProposal | null }): SedimentOutcome {
  void input;
  return { nothing: true, written: [], refused: [] };
}
