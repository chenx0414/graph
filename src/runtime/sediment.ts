/**
 * Skill sedimentation: the review that runs after an operation and turns a lesson into a skill.
 *
 * Two halves, deliberately separate: deciding whether this operation earned a review, and applying
 * whatever the review proposed. The model only ever produces a document and its metadata; writing to
 * disk happens here, so the guards are structural rather than something the prompt promises to honour.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import { normalizeContext } from '@earendil-works/pi-ai';
import type { Context, Model } from '@earendil-works/pi-ai';
import { modelIdentity, type ModelApi, type ModelEntry } from '../catalog/models.ts';
import { DEFAULT_SEDIMENT_PROMPT } from './agent-context.ts';

/** The shape of one write, kept in step with `scripts/skills-lint.mjs` (that linter is the outside check). */
const DESCRIPTION_LIMIT = 300;
const BODY_LIMIT = 24_000;
const ID_LIMIT = 60;
const TRIGGER = /use when|use for|use before|use this when|use this skill when|when the user|when you|何时|当你|适用于/i;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const SKILLS_SEGMENTS = ['.agents', 'skills'];

/** How many existing skills are described to the review, so it folds into one instead of duplicating it. */
const EXISTING_LIMIT = 40;

export interface SedimentSettings {
  enabled: boolean;
  afterToolCalls: number;
  model: string | null;
  budgetTokens: number;
}

/** The documented defaults: the switch is off until somebody says how much work is worth a review. */
export const DEFAULT_SEDIMENT_SETTINGS: SedimentSettings = {
  enabled: false,
  afterToolCalls: 10,
  model: null,
  budgetTokens: 40_000,
};

/** Tolerant by design: a missing or malformed block means the feature is off, never a crash. */
export function sedimentSettings(config: unknown): SedimentSettings {
  const block = (config as { skills?: { sedimentation?: Record<string, unknown> } } | null | undefined)
    ?.skills?.sedimentation;
  const positive = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
  const preferred = typeof block?.['model'] === 'string' ? block['model'].trim() : '';
  return {
    enabled: block?.['enabled'] === true,
    afterToolCalls: positive(block?.['afterToolCalls'], DEFAULT_SEDIMENT_SETTINGS.afterToolCalls),
    model: preferred || DEFAULT_SEDIMENT_SETTINGS.model,
    budgetTokens: positive(block?.['budgetTokens'], DEFAULT_SEDIMENT_SETTINGS.budgetTokens),
  };
}

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
  /** No skill was written. */
  nothing: boolean;
  written: { id: string; path: string; replaced: boolean }[];
  refused: string[];
  /**
   * What the reply actually carried: the action it proposed, `nothing` when it said so, and `null`
   * when nothing readable came back at all. Without this, a silent failure and a deliberate
   * "nothing to save" look identical from the outside.
   */
  proposed: 'create' | 'update' | 'nothing' | null;
}

const NOTHING: SedimentOutcome = { nothing: true, written: [], refused: [], proposed: null };

/** Only the master's own operations are reviewed, and only when they did real work. */
export function shouldSediment(gate: SedimentGate): boolean {
  return gate.enabled
    && gate.role === 'master'
    && !gate.paused
    && !gate.alreadyReviewed
    && gate.threshold > 0
    && gate.toolCalls >= gate.threshold;
}

/** A cheaper, different model does the review: same reasoning as the composer suggestion. */
export function selectSedimentModel(main: ModelEntry, directory: ModelEntry[], preferred: string | null): ModelEntry | undefined {
  if (preferred) {
    const named = directory.find(model => model.id === preferred);
    if (named) return named;
  }
  const mainIdentity = modelIdentity(main);
  const candidates = directory.filter(model => model.id !== main.id && modelIdentity(model) !== mainIdentity);
  for (const grade of ['low', 'medium', 'high', 'highest'] as const) {
    const candidate = candidates.find(model => model.grade === grade);
    if (candidate) return candidate;
  }
  return undefined;
}

/**
 * JSON forbids a raw control character inside a string, and a markdown body arrives full of them:
 * an author writes a line break the way a line break looks. Outside strings the same characters are
 * legal whitespace, so escaping them cannot damage a proposal that was already valid.
 */
function escapeControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f]/g, character => {
    if (character === '\n') return '\\n';
    if (character === '\r') return '\\r';
    if (character === '\t') return '\\t';
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

/** Read a proposal out of whatever the model replied with; anything unreadable is "nothing". */
export function parseSedimentProposal(text: string): SedimentProposal | null {
  const raw = text.trim();
  if (!raw) return null;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  const candidate = raw.slice(start, end + 1);
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    // One repair, narrowly defined: the reply is the proposal with real newlines inside it. Reading it
    // is the difference between a written skill and a silent "nothing"; what it claims is still
    // checked field by field below, and the writer refuses anything outside the project's folder.
    try {
      value = JSON.parse(escapeControlCharacters(candidate));
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const action = record['action'];
  if (action !== 'create' && action !== 'update' && action !== 'nothing') return null;
  if (action === 'nothing') return { action };
  const text_ = (value_: unknown) => (typeof value_ === 'string' ? value_.trim() : undefined);
  return {
    action,
    ...(text_(record['id']) ? { id: text_(record['id'])! } : {}),
    ...(text_(record['description']) ? { description: text_(record['description'])! } : {}),
    ...(text_(record['body']) ? { body: text_(record['body'])! } : {}),
    ...(text_(record['reason']) ? { reason: text_(record['reason'])! } : {}),
  };
}

/** Existing skills with their descriptions, so the review can fold into one instead of duplicating it. */
export function existingSkillSummaries(projectRoot: string): { id: string; description: string }[] {
  const base = join(projectRoot, ...SKILLS_SEGMENTS);
  if (!existsSync(base)) return [];
  const summaries: { id: string; description: string }[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    const path = join(base, entry.name, 'SKILL.md');
    if (!existsSync(path)) continue;
    const text = readFileSync(path, 'utf8');
    const description = /^description:\s*(.*)$/m.exec(text)?.[1]?.trim() ?? '';
    summaries.push({ id: entry.name, description: description.slice(0, DESCRIPTION_LIMIT) });
    if (summaries.length >= EXISTING_LIMIT) break;
  }
  return summaries;
}

/**
 * Write what the review proposed — or refuse it. Every bound is enforced here: an id we cannot turn
 * into a safe path, a description no model could trigger on, an empty body, and any attempt to
 * overwrite a skill somebody else wrote.
 */
export function applySedimentProposal(input: { projectRoot: string; proposal: SedimentProposal | null }): SedimentOutcome {
  const proposal = input.proposal;
  if (!proposal) return NOTHING;
  if (proposal.action === 'nothing') return { ...NOTHING, proposed: 'nothing' };
  const refused: string[] = [];
  const id = proposal.id ?? '';
  const description = proposal.description ?? '';
  const body = (proposal.body ?? '').trim();

  if (!ID_PATTERN.test(id) || id.length > ID_LIMIT) {
    refused.push(`refused: id ${JSON.stringify(id)} is not a lowercase slug of at most ${ID_LIMIT} characters`);
  }
  if (!description || description.length > DESCRIPTION_LIMIT || !TRIGGER.test(description)) {
    refused.push('refused: description must be one sentence that says when to use the skill ("Use when …"), under 300 characters');
  }
  if (!body || body.length > BODY_LIMIT) {
    refused.push(`refused: body must be markdown between 1 and ${BODY_LIMIT} characters`);
  }
  if (refused.length) return { nothing: false, written: [], refused, proposed: proposal.action };

  const skillsRoot = resolve(input.projectRoot, ...SKILLS_SEGMENTS);
  const dir = join(skillsRoot, id);
  if (!(resolve(dir) + sep).startsWith(skillsRoot + sep)) {
    return { nothing: false, written: [], refused: [`refused: ${id} resolves outside the project skill folder`], proposed: proposal.action };
  }
  const path = join(dir, 'SKILL.md');
  let replaced = false;
  if (existsSync(path)) {
    if (!/^---[\s\S]*?^created-by:\s*graph-agent\s*$/m.test(readFileSync(path, 'utf8'))) {
      return { nothing: false, written: [], refused: [`refused: skill '${id}' was not written by us (no created-by: graph-agent); it is somebody else's text`], proposed: proposal.action };
    }
    replaced = true;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `---\nname: ${id}\ncreated-by: graph-agent\ndescription: ${description}\n---\n\n${body}\n`);
  return { nothing: false, written: [{ id, path, replaced }], refused: [], proposed: proposal.action };
}

function textFromMessage(message: { content?: unknown }) {
  if (!Array.isArray(message.content)) return '';
  return message.content
    .flatMap(part => part && typeof part === 'object' && !Array.isArray(part)
      && (part as { type?: unknown }).type === 'text'
      && typeof (part as { text?: unknown }).text === 'string'
      ? [(part as { text: string }).text]
      : [])
    .join('');
}

/**
 * What one review call gave back. `raw` is whatever arrived and survives even when it is unusable,
 * because "no proposal" has two opposite causes — a truncated or prose answer, or a call that never
 * finished — and only the raw text tells them apart.
 */
export interface SedimentReply {
  /** The text when the call finished normally; null when it did not, however much text arrived. */
  text: string | null;
  raw: string;
  stopReason: string | null;
  /** Why the call produced nothing usable: the provider's or transport's own words. */
  error: string | null;
}

/** One fresh model call for the review. The operation's transcript crosses as data, never as context. */
export async function generateSkillProposal(input: {
  stream: StreamFn;
  model: Model<ModelApi>;
  systemPrompt?: string;
  payload: unknown;
  signal?: AbortSignal;
}): Promise<SedimentReply> {
  const context: Context = {
    systemPrompt: input.systemPrompt?.trim() || DEFAULT_SEDIMENT_PROMPT,
    messages: [{
      role: 'user',
      content: JSON.stringify(input.payload).slice(0, 16_000),
      timestamp: Date.now(),
    }],
  };
  try {
    const stream = await input.stream(input.model, normalizeContext(context), {
      maxTokens: 2_000,
      reasoning: 'minimal',
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const message = await stream.result();
    const raw = textFromMessage(message);
    // The SDK reports its own reason on the message when the provider stopped abnormally.
    const reported = (message as unknown as { errorMessage?: unknown }).errorMessage;
    return {
      text: message.stopReason === 'stop' ? raw : null,
      raw,
      stopReason: message.stopReason ?? null,
      error: typeof reported === 'string' && reported ? reported : null,
    };
  } catch (error) {
    return { text: null, raw: '', stopReason: null, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The whole review, with the model call injected: gate, ask, parse, apply. Callers that cannot
 * afford a model call (or want a deterministic check) pass their own `review`.
 */
export async function runSedimentReview(input: {
  gate: SedimentGate;
  settings: SedimentSettings;
  projectRoot: string;
  payload: unknown;
  review: () => Promise<string | null>;
}): Promise<{ reviewed: boolean; outcome: SedimentOutcome }> {
  const gate: SedimentGate = {
    ...input.gate,
    enabled: input.gate.enabled && input.settings.enabled,
    threshold: input.settings.afterToolCalls,
  };
  if (!shouldSediment(gate)) return { reviewed: false, outcome: NOTHING };
  const reply = await input.review();
  const outcome = applySedimentProposal({ projectRoot: input.projectRoot, proposal: parseSedimentProposal(reply ?? '') });
  return { reviewed: true, outcome };
}
