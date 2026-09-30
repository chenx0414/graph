import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { digest } from './context.ts';
import { GraphPlan, type GraphState } from './graph.ts';
import { canonicalJson, type TaskStore } from './store.ts';
import { WriteLedger } from './write-ledger.ts';
import {
  RuntimeError,
  type Json,
  type NodeSpec,
  type Operation,
  type OperationResult,
  type PredecessorHandoffMode,
  type PredecessorHandoffPolicy,
  type PredecessorHandoffProjection,
  type Proposal,
  type ResultHandoff,
  type ResultHandoffDraft,
} from './types.ts';

const DEFAULT_RESULT_SCHEMA = { kind: 'result_handoff', version: 1 } as const;
const DEFAULT_MAX_SUMMARY_CHARS = 2_000;
const MAX_SUMMARY_CHARS = 4_000;

function hasTranscriptFacts(spec: NodeSpec) {
  return spec.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call') ?? false;
}

function independentReviewReceiver(spec: NodeSpec) {
  return spec.context?.purpose === 'review' || spec.context?.purpose === 'verify'
    || (spec.context?.independence !== undefined && spec.context.independence !== 'none')
    || /review|verify|jury|critic/i.test(spec.action)
    || spec.definitionVersion?.startsWith('reviewer@') === true;
}

function freshPredecessorPoliciesApply(spec: NodeSpec) {
  return spec.kind === 'agent'
    && !spec.context?.sourceNode
    && !hasTranscriptFacts(spec)
    && (spec.dependsOn?.length ?? 0) > 0;
}

function implementationReceiver(spec: NodeSpec) {
  return spec.context?.purpose === 'implement' || spec.context?.purpose === 'rework'
    || /work|implement|rework/i.test(spec.action);
}

export function defaultPredecessorHandoffMode(spec: NodeSpec, source?: NodeSpec): PredecessorHandoffMode | undefined {
  if (independentReviewReceiver(spec)) return 'evidence_only';
  if (!source || source.kind !== 'agent' || source.role === 'master') return 'evidence_only';
  return implementationReceiver(spec) ? 'result_handoff' : undefined;
}

function operationResultDigest(result: OperationResult) {
  return digest({
    outcome: result.outcome,
    output: result.output,
    evidence: result.evidence ?? [],
    artifacts: result.artifacts ?? [],
    route: result.route ?? null,
  });
}

function text(value: unknown, max: number) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : undefined;
}

function stringList(value: unknown, maxItems = 50, maxLength = 500): string[] | undefined {
  if (!Array.isArray(value) || value.length > maxItems) return undefined;
  const items = value.map(item => text(item, maxLength));
  return items.every((item): item is string => item !== undefined) ? items : undefined;
}

/**
 * The literal shape a result_handoff@1 submission must have, shown verbatim in the worker's briefing. It
 * is the ONE place the promised schema and the validator can disagree, and they did: the three string
 * lists were shown as bare `[]` while the validator demands short strings, so a review lane sent objects
 * in nextActions and was refused at settle for a field whose type it was never told. Every field names
 * its element type, and a test parses this string against the validator's own rules.
 */
export const RESULT_HANDOFF_SCHEMA_EXAMPLE = '{"schemaVersion":1,"objective":"<bounded goal>","outcome":"completed|partial|blocked","workSummary":"<bounded work result summary>","changes":[{"kind":"file|artifact|external","path":"<the path you wrote; relative to your work copy is fine>","digest":"<sha256, or omit it and the host hashes the file>","artifactId":"<shared artifact id when published>","version":"<exact shared version>","uri":"<artifact uri when present>","summary":"<bounded summary>"}],"decisions":[{"decision":"...","rationale":"...","evidenceRefs":["<path or uri>"]}],"verification":[{"summary":"...","result":"pass|fail|unknown","evidenceRefs":["<path or uri>"]}],"knownLimits":["<short string>"],"openQuestions":["<short string>"],"nextActions":["<short string>"]}';

function evidenceRefs(value: unknown): string[] | undefined {
  return stringList(value, 20, 300);
}

/**
 * Why a submission was rejected, and who can fix it:
 * - representation: the host can often rebuild it from recorded truth (paths,
 *   digests, versions, artifact identity) - never worth redoing the work.
 * - semantic: only the worker knows the answer (missing objective, verdict...).
 * - safety: the claim cannot be tied to real content and must stay refused.
 */
export type HandoffDefectClass = 'representation' | 'semantic' | 'safety';

export interface HandoffDefect {
  /** JSON-ish location of the offending field, for example changes[3].path. */
  path: string;
  class: HandoffDefectClass;
  expected: string;
  got: string;
}

export interface HandoffInspection {
  draft?: ResultHandoffDraft;
  defects: HandoffDefect[];
}

function preview(value: unknown) {
  if (value === undefined) return 'missing';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) return String(value);
  return encoded.length > 120 ? `${encoded.slice(0, 117)}...` : encoded;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Structural inspection of a final (already host-normalised) handoff. Collects
 * every defect instead of stopping at the first one, so a worker can fix a whole
 * shape in one turn and the main Agent can see exactly what is missing.
 */
function inspectDraft(value: unknown): HandoffInspection {
  const defects: HandoffDefect[] = [];
  const reject = (path: string, defectClass: HandoffDefectClass, expected: string, got: unknown) => {
    defects.push({ path, class: defectClass, expected, got: preview(got) });
  };
  if (!isRecord(value)) {
    reject('$', 'semantic', 'a JSON object', value);
    return { defects };
  }
  const raw = value;
  if (raw.schemaVersion !== 1) reject('schemaVersion', 'semantic', 'the number 1', raw.schemaVersion);
  const objective = text(raw.objective, 500);
  if (!objective) reject('objective', 'semantic', 'a nonempty string of at most 500 characters', raw.objective);
  const workSummary = text(raw.workSummary, MAX_SUMMARY_CHARS);
  if (!workSummary) reject('workSummary', 'semantic', `a nonempty string of at most ${MAX_SUMMARY_CHARS} characters`, raw.workSummary);
  const outcome = raw.outcome === 'completed' || raw.outcome === 'partial' || raw.outcome === 'blocked' ? raw.outcome : undefined;
  if (!outcome) reject('outcome', 'semantic', 'one of completed, partial, blocked', raw.outcome);

  const changes: ResultHandoffDraft['changes'] = [];
  if (!Array.isArray(raw.changes)) reject('changes', 'semantic', 'an array of at most 100 changes', raw.changes);
  else if (raw.changes.length > 100) reject('changes', 'semantic', 'an array of at most 100 changes', raw.changes.length);
  else for (const [index, item] of raw.changes.entries()) {
    const at = `changes[${index}]`;
    if (!isRecord(item)) { reject(at, 'semantic', 'a change object', item); continue; }
    const summary = text(item.summary, 500);
    if (!summary) reject(`${at}.summary`, 'semantic', 'a nonempty string of at most 500 characters', item.summary);
    if (!['file', 'artifact', 'external'].includes(String(item.kind))) {
      reject(`${at}.kind`, 'semantic', 'one of file, artifact, external', item.kind);
      continue;
    }
    const path = item.path === undefined ? undefined : text(item.path, 2_000);
    if (item.path !== undefined && path === undefined) reject(`${at}.path`, 'representation', 'a path string of at most 2000 characters', item.path);
    if (path && !isAbsolute(path)) reject(`${at}.path`, 'representation', 'an absolute path or a path inside the work copy', item.path);
    const digest = item.digest === undefined ? undefined : text(item.digest, 64);
    if (item.digest !== undefined && (digest === undefined || !/^[a-f0-9]{64}$/.test(digest))) {
      reject(`${at}.digest`, 'representation', 'a sha256 hex digest', item.digest);
    }
    const artifactId = item.artifactId === undefined ? undefined : text(item.artifactId, 200);
    const artifactVersion = item.version === undefined ? undefined : versionNumber(item.version);
    if (item.version !== undefined && artifactVersion === undefined) reject(`${at}.version`, 'representation', 'a positive integer version', item.version);
    if ((artifactId === undefined) !== (artifactVersion === undefined)) {
      reject(`${at}.artifactId`, 'representation', 'artifactId and version together', item.artifactId);
    }
    if (artifactId && !text(item.uri, 500)) reject(`${at}.uri`, 'representation', 'the artifact uri returned by artifact_publish', item.uri);
    if (item.kind === 'file' && !path) reject(`${at}.path`, 'representation', 'a path inside the work copy', item.path);
    else if (item.kind === 'file' && !digest) {
      reject(`${at}.digest`, 'representation', 'a file that exists in the work copy so the host can hash it', item.digest);
    }
    if (item.kind === 'artifact' && !((path && digest) || (artifactId && artifactVersion !== undefined))) {
      reject(`${at}`, 'representation', 'an artifact change needs a published artifactId with version, or a path with digest', item);
    }
    if (!summary) continue;
    changes.push({
      kind: item.kind as ResultHandoffDraft['changes'][number]['kind'],
      ...(path ? { path } : {}),
      ...(digest ? { digest } : {}),
      ...(artifactId ? { artifactId } : {}),
      ...(artifactVersion !== undefined ? { version: artifactVersion } : {}),
      ...(text(item.uri, 500) ? { uri: text(item.uri, 500)! } : {}),
      summary,
    });
  }

  const decisions: ResultHandoffDraft['decisions'] = [];
  if (!Array.isArray(raw.decisions) || raw.decisions.length > 50) reject('decisions', 'semantic', 'an array of at most 50 decisions', raw.decisions);
  else for (const [index, item] of raw.decisions.entries()) {
    const at = `decisions[${index}]`;
    if (!isRecord(item)) { reject(at, 'semantic', 'a decision object', item); continue; }
    const decision = text(item.decision, 800);
    const rationale = text(item.rationale, 1_000);
    const refs = evidenceRefs(item.evidenceRefs ?? []);
    if (!decision) reject(`${at}.decision`, 'semantic', 'a nonempty string of at most 800 characters', item.decision);
    if (!rationale) reject(`${at}.rationale`, 'semantic', 'a nonempty string of at most 1000 characters', item.rationale);
    if (!refs) reject(`${at}.evidenceRefs`, 'semantic', 'an array of at most 20 short strings', item.evidenceRefs);
    if (decision && rationale && refs) decisions.push({ decision, rationale, evidenceRefs: refs });
  }

  const verification: ResultHandoffDraft['verification'] = [];
  if (!Array.isArray(raw.verification) || raw.verification.length > 50) reject('verification', 'semantic', 'an array of at most 50 checks', raw.verification);
  else for (const [index, item] of raw.verification.entries()) {
    const at = `verification[${index}]`;
    if (!isRecord(item)) { reject(at, 'semantic', 'a verification object', item); continue; }
    const summary = text(item.summary, 800);
    const refs = evidenceRefs(item.evidenceRefs ?? []);
    const result = ['pass', 'fail', 'unknown'].includes(String(item.result)) ? item.result as 'pass' | 'fail' | 'unknown' : undefined;
    if (!summary) reject(`${at}.summary`, 'semantic', 'a nonempty string of at most 800 characters', item.summary);
    if (!result) reject(`${at}.result`, 'semantic', 'one of pass, fail, unknown', item.result);
    if (!refs) reject(`${at}.evidenceRefs`, 'semantic', 'an array of at most 20 short strings', item.evidenceRefs);
    if (summary && result && refs) verification.push({ summary, result, evidenceRefs: refs });
  }

  const knownLimits = stringList(raw.knownLimits ?? []);
  const openQuestions = stringList(raw.openQuestions ?? []);
  const nextActions = stringList(raw.nextActions ?? []);
  if (!knownLimits) reject('knownLimits', 'semantic', 'an array of at most 50 short strings', raw.knownLimits);
  if (!openQuestions) reject('openQuestions', 'semantic', 'an array of at most 50 short strings', raw.openQuestions);
  if (!nextActions) reject('nextActions', 'semantic', 'an array of at most 50 short strings', raw.nextActions);

  if (defects.length || !objective || !workSummary || !outcome || !knownLimits || !openQuestions || !nextActions) {
    return { defects };
  }
  return {
    draft: { schemaVersion: 1, objective, outcome, workSummary, changes, decisions, verification, knownLimits, openQuestions, nextActions },
    defects: [],
  };
}

function normalizeDraft(value: unknown): ResultHandoffDraft | undefined {
  return inspectDraft(value).draft;
}

export function resultHandoffFromSubmission(value: Json | undefined) {
  return normalizeDraft(value);
}

/** Resolve a work-copy-relative path, refusing anything that escapes the workspace. */
function withinWorkspace(workspace: string, path: string) {
  const root = resolve(workspace);
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel)) ? target : undefined;
}

/**
 * Digest the file the worker actually left in its work copy. The host reads the
 * bytes itself, so a handoff never depends on a model-reported digest.
 */
function workspaceDigest(workspace: string | undefined, path: string) {
  if (!workspace) return undefined;
  const target = withinWorkspace(workspace, path);
  if (!target) return undefined;
  try {
    return createHash('sha256').update(readFileSync(target)).digest('hex');
  } catch {
    return undefined;
  }
}

export interface ResultHandoffRecoveryContext {
  workspace?: string;
  /**
   * What this lane's own ledger says it wrote. When present, the manifest is checked against it:
   * a change the disk does not record, a digest that disagrees with the bytes, or a real change
   * the manifest omits all make the submission unusable, because the point of the manifest is to
   * be a receipt rather than a claim.
   */
  changeSet?: readonly { path: string; afterDigest: string | null; status: 'added' | 'modified' | 'deleted' }[];
  /** The paths this node declares. A change outside it belongs to another lane. */
  scope?: readonly string[];
  /**
   * Recorded identity for an artifact the worker named loosely, such as the
   * logical `namespace/name` instead of the id the publish call returned.
   */
  rebindArtifact?(change: { artifactId?: unknown; version?: unknown; uri?: unknown }): {
    artifactId: string; version: number; digest?: string;
  } | undefined;
}

/** Read a version the worker wrote as either a number or a numeric string. */
function versionNumber(value: unknown) {
  const version = typeof value === 'number' ? value
    : typeof value === 'string' && /^[1-9][0-9]*$/.test(value) ? Number(value) : undefined;
  return version !== undefined && Number.isSafeInteger(version) && version > 0 ? version : undefined;
}

/**
 * Apply everything the host can establish on its own: relative paths are
 * resolved inside the work copy, digests recomputed from the bytes on disk,
 * missing file digests filled in, and loose artifact references bound to the
 * recorded version. Whatever the host cannot establish is left untouched for
 * the inspector to report.
 */
function rebaseSubmission(value: unknown, context: ResultHandoffRecoveryContext) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.changes)) return raw;
  const changes = raw.changes.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const change = { ...(item as Record<string, unknown>) };
    if (typeof change.path === 'string' && context.workspace) {
      const target = withinWorkspace(context.workspace, change.path);
      if (target) {
        change.path = target;
        const actual = workspaceDigest(context.workspace, target);
        // The bytes on disk are the truth for anything the worker wrote; a
        // model-reported digest is only kept when the host cannot check it.
        if (actual && (change.kind === 'file' || change.digest === undefined)) change.digest = actual;
      }
    }
    const bound = context.rebindArtifact?.(change);
    if (bound) {
      change.artifactId = bound.artifactId;
      change.version = bound.version;
      if (bound.digest) change.digest = bound.digest;
    }
    return change;
  });
  return { ...raw, changes };
}

export interface HandoffInspectionResult {
  /** Present only when the submission is usable after host repair. */
  draft?: ResultHandoffDraft;
  /** Everything still wrong, in the worker's own field coordinates. */
  defects: HandoffDefect[];
  /** The host had to supply or correct at least one field. */
  repaired: boolean;
}

/**
 * Compare a manifest's file changes with the lane's own record and the bytes on disk.
 *
 * A digest a worker wrote is never trusted over the disk: where the two disagree the disk wins,
 * and the defect says so. This is the difference between a receipt and a self-assessment.
 */
function checkChangesAgainstLane(
  draft: ResultHandoffDraft,
  context: ResultHandoffRecoveryContext,
  asserted: ResultHandoffDraft = draft,
): HandoffDefect[] {
  if (!context.changeSet) return [];
  const defects: HandoffDefect[] = [];
  // The digests the worker itself asserted, by lane-relative path, so host repair cannot hide a
  // claim that contradicts the disk.
  const assertedDigest = new Map<string, string | undefined>();
  for (const change of asserted.changes) {
    if (change.kind !== 'file' || !change.path) continue;
    assertedDigest.set(laneRelative(context.workspace, change.path), change.digest);
  }
  const claimed = new Map<string, ResultHandoffDraft['changes'][number]>();
  for (const change of draft.changes) {
    if (change.kind !== 'file' || !change.path) continue;
    const relative = laneRelative(context.workspace, change.path);
    claimed.set(relative, change);
  }
  const recorded = new Map(context.changeSet.map(change => [change.path.split('\\').join('/'), change]));
  for (const [relative] of claimed) {
    const real = recorded.get(relative);
    if (!real) {
      defects.push({
        path: `changes[path=${relative}]`, class: 'safety',
        expected: 'a file this lane recorded a change for',
        got: `${relative} has no change recorded in this lane's ledger`,
      });
      continue;
    }
    if (context.scope && !context.scope.some(owned => relative === owned || relative.startsWith(owned.endsWith('/') ? owned : `${owned}/`))) {
      defects.push({
        path: `changes[path=${relative}]`, class: 'semantic',
        expected: 'a path inside this node declared file list',
        got: `${relative} belongs to another lane`,
      });
      continue;
    }
    const workerDigest = assertedDigest.get(relative);
    // A file that exists on disk is judged by its bytes; a deleted file has no digest and is
    // judged by the ledger alone.
    if (real.afterDigest && workerDigest !== undefined && workerDigest !== real.afterDigest) {
      defects.push({
        path: `changes[path=${relative}].digest`, class: 'representation',
        expected: `the digest of the bytes this lane wrote (${real.afterDigest})`,
        got: workerDigest,
      });
    }
  }
  for (const [relative] of recorded) {
    if (claimed.has(relative)) continue;
    defects.push({
      path: `changes[path=${relative}]`, class: 'safety',
      expected: 'every file this lane changed to appear in changes',
      got: `${relative} was changed by this lane but is missing from the manifest`,
    });
  }
  return defects;
}

/** A lane-relative identity for a path a worker wrote either absolutely or relatively. */
function laneRelative(workspace: string | undefined, path: string): string {
  const normalized = path.split('\\').join('/');
  if (!workspace) return normalized;
  const root = resolve(workspace).split('\\').join('/').replace(/\/$/, '');
  return normalized === root ? '' : normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

/**
 * Inspect a worker submission the way the harness will: accept what already
 * validates, otherwise rebuild from recorded truth and report the leftovers.
 * The tool call and the settle path share this so a worker gets the same answer
 * inside its turn as the harness would give after it.
 */
export function inspectResultHandoffSubmission(value: Json | undefined, context: ResultHandoffRecoveryContext = {}): HandoffInspectionResult {
  const direct = inspectDraft(value);
  const rebased = rebaseSubmission(value, context);
  if (!rebased) return { defects: direct.defects, repaired: false };
  const after = inspectDraft(rebased);
  // The host re-establishes what it can (work-copy paths, digests, artifact
  // identity) before judging the submission, so a worker is never failed for a
  // field the harness can fill in itself.
  if (after.draft) {
    // A structurally valid manifest is not yet a true one: the lane's own ledger decides whether
    // the receipt matches what happened, and a mismatch is a safety defect rather than a shape one.
    // The check reads the worker's own digests, before the host repaired them, because a digest
    // the worker asserted and the disk contradicts is exactly the claim this rule must refuse.
    const ledgerDefects = checkChangesAgainstLane(after.draft, context, direct.draft ?? after.draft);
    if (ledgerDefects.length) return { defects: ledgerDefects, repaired: !direct.draft };
    return { draft: after.draft, defects: [], repaired: !direct.draft };
  }
  return { defects: after.defects.length ? after.defects : direct.defects, repaired: true };
}

/**
 * Rebuild an admissible draft from a submission the worker wrote against its own
 * work copy. Anything that cannot be tied to real workspace or recorded artifact
 * content still fails closed.
 */
export function recoverResultHandoffDraft(value: Json | undefined, context: ResultHandoffRecoveryContext) {
  return inspectResultHandoffSubmission(value, context).draft;
}

/**
 * The host truth a handoff may be rebuilt from: the worker's work copy and the
 * artifacts this task actually recorded. Tool calls and settle share it so a
 * worker is judged the same way before and after its turn ends.
 */
export function resultHandoffRecoveryContext(store: TaskStore, operation: { taskId: string; workspace?: string }): ResultHandoffRecoveryContext {
  return {
    ...(operation.workspace ? { workspace: operation.workspace } : {}),
    rebindArtifact: change => recordedArtifact(store, operation.taskId, change),
  };
}

/**
 * What a node's own lane recorded, so its manifest is judged against the disk.
 *
 * The ledger is read at submission time rather than captured when the turn started, because a
 * worker may correct its manifest several times inside one turn and each submission must be
 * compared with what the disk holds at that moment. A node with no ledger - a program node, a
 * read-only role, or a historical task - simply gets no cross-check, never a false rejection.
 */
export function laneSubmissionContext(
  store: TaskStore,
  operation: { taskId: string; nodeId?: string; workspace?: string; scope?: readonly string[] },
): ResultHandoffRecoveryContext {
  const base = resultHandoffRecoveryContext(store, operation);
  if (!operation.nodeId) return base;
  const ledger = new WriteLedger(store);
  const changeSet = ledger.changes(operation.taskId, operation.nodeId);
  const declared = operation.scope ?? declaredFiles(store, operation.taskId, operation.nodeId);
  return {
    ...base,
    ...(changeSet.length ? { changeSet } : {}),
    ...(declared && declared.length ? { scope: declared } : {}),
  };
}

/** The paths a node declares in its own spec, or null when it declares none. */
function declaredFiles(store: TaskStore, taskId: string, nodeId: string): string[] | null {
  const row = store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(taskId, nodeId) as { spec: string } | undefined;
  if (!row) return null;
  try {
    const spec = JSON.parse(row.spec) as NodeSpec;
    const input = spec.input && typeof spec.input === 'object' && !Array.isArray(spec.input) ? spec.input as Record<string, unknown> : null;
    const files = input?.['files'];
    return Array.isArray(files) && files.every(item => typeof item === 'string') ? files as string[] : null;
  } catch {
    return null;
  }
}

export function validatePredecessorPolicies(proposal: Proposal, plan: GraphPlan, nodes: Map<string, NodeSpec>) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  for (const node of proposal.nodes) {
    const { policies, orphaned, missing } = predecessorPoliciesForNode(node, nodes);
    if (orphaned.length) invalid(`Unknown predecessor handoff source ${orphaned[0]!.source}`);
    if (missing.length) invalid(`Fresh predecessor edge ${missing[0]} requires an explicit handoff policy`);
    if (!policies.length) continue;
    if (node.kind !== 'agent') invalid('Only Agent nodes may declare predecessor handoff policies');
    if (hasTranscriptFacts(node)) {
      invalid('Fork facts cannot be combined with Fresh predecessor handoff policies');
    }
    const sources = new Set<string>();
    for (const policy of policies) {
      if (sources.has(policy.source)) invalid(`Duplicate predecessor handoff policy for ${policy.source}`);
      sources.add(policy.source);
      if (!(node.dependsOn ?? []).includes(policy.source)) invalid(`Predecessor ${policy.source} must be a direct dependency of ${node.id}`);
      if (policy.mode === 'result_handoff') {
        for (const leaf of plan.leaves(policy.source)) {
          const source = nodes.get(leaf);
          if (!source) throw new RuntimeError('invalid_proposal', `Result handoff source ${policy.source} must contain only Agent nodes`);
          if (source.kind !== 'agent') invalid(`Result handoff source ${policy.source} must contain only Agent nodes`);
        }
      }
      if (independentReviewReceiver(node) && policy.mode !== 'evidence_only') {
        invalid('Independent review and verification require evidence_only predecessor handoff');
      }
    }
  }
}

export function predecessorPoliciesForNode(spec: NodeSpec, sourceNodes?: Map<string, NodeSpec>) {
  const explicit = new Map((spec.context?.predecessors ?? []).map(policy => [policy.source, policy]));
  if (!freshPredecessorPoliciesApply(spec)) {
    return { policies: [], orphaned: [...explicit.values()], missing: [] };
  }
  const policies: PredecessorHandoffPolicy[] = [];
  const missing: string[] = [];
  for (const source of spec.dependsOn ?? []) {
    const policy = explicit.get(source);
    if (policy) policies.push(policy);
    else {
      const mode = defaultPredecessorHandoffMode(spec, sourceNodes?.get(source));
      if (mode) policies.push({ source, mode });
      else missing.push(source);
    }
    explicit.delete(source);
  }
  return { policies, orphaned: [...explicit.values()], missing };
}

export function predecessorPolicyDigest(policies: PredecessorHandoffPolicy[]) {
  return digest(policies);
}

function resultSourcesByNode(proposal: Proposal, plan: GraphPlan) {
  const sources = new Set<string>();
  for (const node of proposal.nodes) {
    for (const policy of predecessorPoliciesForNode(node, plan.nodes).policies) {
      if (policy.mode !== 'result_handoff') continue;
      for (const leaf of plan.leaves(policy.source)) sources.add(leaf);
    }
  }
  return sources;
}

function resultPoliciesForSource(proposal: Proposal, nodeId: string, plan: GraphPlan) {
  const policies: PredecessorHandoffPolicy[] = [];
  for (const node of proposal.nodes) {
    for (const policy of predecessorPoliciesForNode(node, plan.nodes).policies) {
      if (policy.mode !== 'result_handoff') continue;
      if (plan.leaves(policy.source).includes(nodeId)) policies.push(policy);
    }
  }
  return policies;
}

export function requiresResultHandoff(proposal: Proposal, nodeId: string) {
  return resultSourcesByNode(proposal, new GraphPlan(proposal)).has(nodeId);
}

export function resultSummaryLimit(proposal: Proposal, nodeId: string) {
  const policies = resultPoliciesForSource(proposal, nodeId, new GraphPlan(proposal));
  return policies.length
    ? Math.min(...policies.map(policy => policy.maxSummaryChars ?? DEFAULT_MAX_SUMMARY_CHARS))
    : DEFAULT_MAX_SUMMARY_CHARS;
}

export function resultHandoffDependents(proposal: Proposal, sourceNodeId: string) {
  const plan = new GraphPlan(proposal);
  return proposal.nodes
    .filter(node => predecessorPoliciesForNode(node, plan.nodes).policies.some(policy =>
      policy.mode === 'result_handoff' && plan.leaves(policy.source).includes(sourceNodeId)))
    .map(node => node.id);
}

export function outputSchemaForNode(proposal: Proposal, nodeId: string) {
  return requiresResultHandoff(proposal, nodeId) ? DEFAULT_RESULT_SCHEMA : { kind: 'agent_result', version: 1 } as const;
}

function evidenceProjection(store: TaskStore, source: {
  nodeId: string;
  operationId: string;
  activationId: string;
  outputVersion: number;
  artifacts: { path: string; digest: string; artifactId?: string; version?: number; uri?: string }[];
}): { artifactRefs: { path: string; digest: string }[]; evidenceRefs: PredecessorHandoffProjection['evidenceRefs'] } {
  const rows = store.db.prepare('SELECT data FROM evidence WHERE operation_id=? ORDER BY rowid').all(source.operationId) as { data: string }[];
  const evidenceRefs = rows.flatMap(row => {
    const data = JSON.parse(row.data) as {
      acceptanceId?: string;
      summary?: string;
      artifact?: { path?: string; digest?: string };
    };
    if (!data.acceptanceId || !data.summary || !data.artifact?.path || !data.artifact.digest) return [];
    return [{
      acceptanceId: data.acceptanceId,
      summary: data.summary,
      path: data.artifact.path,
      digest: data.artifact.digest,
    }];
  });
  return {
      artifactRefs: source.artifacts.map(artifact => ({
        path: artifact.path,
        digest: artifact.digest,
        ...(artifact.artifactId ? { artifactId: artifact.artifactId } : {}),
        ...(artifact.version !== undefined ? { version: artifact.version } : {}),
        ...(artifact.uri ? { uri: artifact.uri } : {}),
      })),
    evidenceRefs,
  };
}

function readResultHandoff(store: TaskStore, source: {
  nodeId: string;
  instanceId: string | null;
  operationId: string;
  activationId: string;
  outputVersion: number;
}, policy: PredecessorHandoffPolicy) {
  const row = store.db.prepare(`SELECT body,digest,schema_kind,schema_version,instance_id FROM result_handoffs
    WHERE node_id=? AND operation_id=? AND activation_id=? AND output_version=?`)
    .get(source.nodeId, source.operationId, source.activationId, source.outputVersion) as {
      body: string;
      digest: string;
      schema_kind: string;
      schema_version: number;
      instance_id: string;
    } | undefined;
  if (!row) throw new RuntimeError('context_rejected', `Result handoff is missing for ${source.nodeId}`);
  const expected = policy.resultSchema ?? DEFAULT_RESULT_SCHEMA;
  if (row.schema_kind !== expected.kind || row.schema_version !== expected.version) {
    throw new RuntimeError('context_rejected', `Result handoff schema mismatch for ${source.nodeId}`);
  }
  const body = JSON.parse(row.body) as ResultHandoff;
  if (digest(body) !== row.digest) throw new RuntimeError('context_rejected', `Result handoff digest mismatch for ${source.nodeId}`);
  if (row.instance_id !== body.source.instanceId || (source.instanceId !== null && source.instanceId !== body.source.instanceId)) {
    throw new RuntimeError('context_rejected', `Result handoff instance mismatch for ${source.nodeId}`);
  }
  const operationRow = store.db.prepare('SELECT result FROM operations WHERE id=?').get(source.operationId) as { result: string | null } | undefined;
  if (!operationRow?.result) throw new RuntimeError('context_rejected', `Result handoff operation result is missing for ${source.nodeId}`);
  const operationResult = JSON.parse(operationRow.result) as OperationResult;
  // Rows written before HB-216 recorded the digest of the result as it stood BEFORE the harness
  // registered its own acceptance evidence, so they name a form the store no longer holds. That form
  // is recomputed here from the stored result, which is why accepting it costs no safety: a tampered
  // outcome, output, route or artifact set matches neither form and is still refused.
  if (body.source.operationResultDigest !== operationResultDigest(operationResult)
    && body.source.operationResultDigest !== operationResultDigest({ ...operationResult, evidence: [] })) {
    throw new RuntimeError('context_rejected', `Result handoff operation result mismatch for ${source.nodeId}`);
  }
  if (body.source.nodeId !== source.nodeId || body.source.operationId !== source.operationId
    || body.source.activationId !== source.activationId || body.source.outputVersion !== source.outputVersion) {
    throw new RuntimeError('context_rejected', `Result handoff source mismatch for ${source.nodeId}`);
  }
  return {
    body,
    digest: row.digest,
    schema: { kind: row.schema_kind, version: row.schema_version },
    bytes: Buffer.byteLength(row.body, 'utf8'),
  };
}

export function buildPredecessorHandoffs(store: TaskStore, graph: GraphState, spec: NodeSpec) {
  const { policies, orphaned, missing } = predecessorPoliciesForNode(spec, graph.plan.nodes);
  if (orphaned.length) throw new RuntimeError('invalid_adapter', `Unknown predecessor handoff source ${orphaned[0]!.source}`);
  if (missing.length) throw new RuntimeError('invalid_adapter', `Missing predecessor handoff policy for ${missing[0]}`);
  const sourceMap = graph.sources(spec.id);
  const projections: PredecessorHandoffProjection[] = [];
  for (const policy of policies) {
    const sources = sourceMap[policy.source] ?? [];
    if (policy.mode === 'result_handoff' && !sources.length) {
      throw new RuntimeError('context_rejected', `Result handoff source ${policy.source} has no completed provenance`);
    }
    for (const source of sources) {
      const evidence = evidenceProjection(store, source);
      if (policy.mode === 'evidence_only') {
        projections.push({
          sourceNodeId: source.nodeId,
          sourceInstanceId: source.instanceId,
          sourceOperationId: source.operationId,
          sourceActivationId: source.activationId,
          outputVersion: source.outputVersion,
          mode: policy.mode,
          ...evidence,
        });
      } else {
        const resultHandoff = readResultHandoff(store, source, policy);
        projections.push({
          sourceNodeId: source.nodeId,
          sourceInstanceId: resultHandoff.body.source.instanceId,
          sourceOperationId: source.operationId,
          sourceActivationId: source.activationId,
          outputVersion: source.outputVersion,
          mode: policy.mode,
          ...evidence,
          resultHandoff: resultHandoff.body,
          resultHandoffDigest: resultHandoff.digest,
          resultHandoffSchema: resultHandoff.schema,
          resultHandoffBytes: resultHandoff.bytes,
        });
      }
    }
  }
  return { policies, projections };
}

function failedHandoffResult(result: OperationResult, reason: string, defects: HandoffDefect[] = []): OperationResult {
  const { resultHandoff: _discarded, ...rest } = result;
  return {
    ...rest,
    outcome: 'failed',
    output: { error: { code: 'result_handoff_invalid', reason, defects: defects as unknown as Json }, previousOutput: result.output },
  };
}

export function resultHandoffFailure(result: OperationResult) {
  if (result.outcome !== 'failed' || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return undefined;
  const error = (result.output as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const details = error as Record<string, unknown>;
  if (details.code !== 'result_handoff_invalid') return undefined;
  const defects = Array.isArray(details.defects) ? details.defects as HandoffDefect[] : [];
  return { reason: typeof details.reason === 'string' ? details.reason : 'Result handoff validation failed', defects };
}

/**
 * Anything a worker submitted that the harness refused to use, whatever part of
 * the result it was: the handoff, the review report or the acceptance evidence.
 * All of them mean "the work may be fine, the document is not", so they share
 * one recovery route instead of becoming an uncertain external outcome.
 */
export function submissionDefect(result: OperationResult): { reason: string; defects: HandoffDefect[]; policy: 'result_handoff' | 'result' } | undefined {
  const handoff = resultHandoffFailure(result);
  if (handoff) return { ...handoff, policy: 'result_handoff' };
  if (result.outcome !== 'failed' || !result.output || typeof result.output !== 'object' || Array.isArray(result.output)) return undefined;
  const error = (result.output as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) return undefined;
  const details = error as Record<string, unknown>;
  if (details.code !== 'result_noncompliant') return undefined;
  return {
    reason: typeof details.reason === 'string' ? details.reason : 'The submitted result could not be used',
    defects: Array.isArray(details.defects) ? details.defects as HandoffDefect[] : [],
    policy: 'result',
  };
}

/** Wrap a refused result so the main Agent can repair it without redoing work. */
export function nonCompliantResult(result: OperationResult, reason: string, defects: HandoffDefect[]): OperationResult {
  const { evidence: _evidence, artifacts: _artifacts, resultHandoff: _handoff, ...rest } = result;
  return {
    ...rest,
    outcome: 'failed',
    output: { error: { code: 'result_noncompliant', reason, defects: defects as unknown as Json }, previousOutput: result.output },
  };
}

export interface ResultHandoffRepair {
  operationId: string;
  reason: string;
  submitted: Json;
}

export interface ResultHandoffRepairDecision {
  questionId?: string;
  value: Json;
}

/**
 * The latest settled attempt on this activation, when its only remaining defect
 * is the handoff its worker submitted. That work is already on disk, so a retry
 * must reconcile the submission instead of running the task briefing again.
 */
export function resultHandoffRepair(store: TaskStore, input: { taskId: string; nodeId: string; activationId: string }): ResultHandoffRepair | undefined {
  const row = store.db.prepare(`SELECT id,result FROM operations
    WHERE task_id=? AND node_id=? AND activation_id=? AND result IS NOT NULL
    ORDER BY rowid DESC LIMIT 1`).get(input.taskId, input.nodeId, input.activationId) as { id: string; result: string } | undefined;
  if (!row) return undefined;
  const result = JSON.parse(row.result) as OperationResult;
  const failure = submissionDefect(result);
  if (!failure) return undefined;
  const output = result.output as Record<string, unknown>;
  return { operationId: row.id, reason: failure.reason, submitted: (output.previousOutput ?? null) as Json };
}

/**
 * A retry after landed work carries the failure and the previous submission,
 * never the original task briefing, and asks for the submission to be repaired
 * instead of the implementation to be redone.
 */
export function renderResultHandoffRepair(repair: ResultHandoffRepair, input: { decisions?: ResultHandoffRepairDecision[] } = {}) {
  const submitted = JSON.stringify(repair.submitted, null, 2);
  const decisions = input.decisions?.length
    ? ['Decisions taken since the failed attempt (apply them; they are the reason for this repair):',
        ...input.decisions.map(decision => `- ${JSON.stringify(decision.value)}`)].join('\n')
    : '';
  return [
    `Retry after a failed handoff on operation ${repair.operationId}.`,
    `Failure: ${repair.reason}`,
    decisions,
    'The previous attempt already did the work in this work copy. Reconcile the submission instead of redoing the implementation:',
    '- Do not rewrite, re-create or re-explore files the previous attempt already produced.',
    '- Resubmit the same work through submit_result, corrected to the required schema.',
    '- If the work is genuinely incomplete, report outcome "partial" or "blocked" with the remaining gap instead of starting over.',
    'Previous submission (repair this, do not discard it):',
    submitted.length > 12_000 ? `${submitted.slice(0, 12_000)}\n…truncated` : submitted,
  ].filter(Boolean).join('\n');
}

/**
 * Every place an unnormalised handoff can hide. Adapters normalise a valid
 * submission into result.resultHandoff; when normalisation rejects it, the
 * untouched submission is still in the operation output, either nested under
 * "resultHandoff" or as the output itself.
 */
function recoveryCandidates(result: OperationResult): Json[] {
  const candidates: Json[] = [];
  if (result.resultHandoff !== undefined) candidates.push(result.resultHandoff as unknown as Json);
  if (result.output && typeof result.output === 'object' && !Array.isArray(result.output)) {
    const nested = (result.output as Record<string, unknown>).resultHandoff;
    if (nested !== undefined) candidates.push(nested as Json);
  }
  if (result.output !== undefined) candidates.push(result.output);
  return candidates;
}

/**
 * Inspect every place the submission can hide and keep the candidate that came
 * closest to valid, so the reported defects describe the worker's own shape.
 */
function inspectSubmission(result: OperationResult, recovery: ResultHandoffRecoveryContext): HandoffInspectionResult {
  let best: HandoffInspectionResult = { defects: [], repaired: false };
  for (const candidate of recoveryCandidates(result)) {
    const inspection = inspectResultHandoffSubmission(candidate, recovery);
    if (inspection.draft) return inspection;
    if (!best.repaired || (inspection.defects.length && inspection.defects.length < best.defects.length)) best = inspection;
  }
  return best;
}

/** The namespace/name a worker may write instead of the published artifact id. */
function logicalArtifactRef(value: unknown) {
  if (typeof value !== 'string') return undefined;
  const marker = '/artifacts/';
  const at = value.indexOf(marker);
  const parts = (at >= 0 ? value.slice(at + marker.length) : value).replace(/@[0-9]+$/, '').split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return undefined;
  try {
    return { namespace: decodeURIComponent(parts[0]), name: decodeURIComponent(parts[1]) };
  } catch {
    return undefined;
  }
}

/**
 * What the host recorded for an artifact this worker published. Accepts the id
 * the publish call returned, or the logical reference the worker wrote instead,
 * and always answers with the recorded identity and digest.
 */
function recordedArtifact(store: TaskStore, taskId: string, change: { artifactId?: unknown; version?: unknown; uri?: unknown }) {
  const version = versionNumber(change.version);
  if (version === undefined) return undefined;
  const columns = 'artifact_id,version,digest';
  if (typeof change.artifactId === 'string') {
    const direct = store.db.prepare(`SELECT ${columns} FROM artifacts WHERE task_id=? AND artifact_id=? AND version=?`)
      .get(taskId, change.artifactId, version) as { artifact_id: string; version: number; digest: string } | undefined;
    if (direct) return { artifactId: direct.artifact_id, version: Number(direct.version), digest: direct.digest };
  }
  const logical = logicalArtifactRef(change.uri) ?? logicalArtifactRef(change.artifactId);
  if (!logical) return undefined;
  const row = store.db.prepare(`SELECT ${columns} FROM artifacts
    WHERE task_id=? AND namespace=? AND name=? AND version=? AND state='published'`)
    .get(taskId, logical.namespace, logical.name, version) as { artifact_id: string; version: number; digest: string } | undefined;
  return row ? { artifactId: row.artifact_id, version: Number(row.version), digest: row.digest } : undefined;
}

export function settleResultHandoff(
  store: TaskStore,
  operation: Operation,
  proposal: Proposal,
  result: OperationResult,
) {
  if (!requiresResultHandoff(proposal, operation.nodeId) || result.outcome !== 'completed') return result;
  const recovery = resultHandoffRecoveryContext(store, operation);
  const inspected = inspectSubmission(result, recovery);
  const draft = inspected.draft;
  if (!draft) {
    return failedHandoffResult(result, 'A downstream edge requires a valid result_handoff@1 submission', inspected.defects);
  }
  const summaryLimit = resultSummaryLimit(proposal, operation.nodeId);
  if (draft.workSummary.length > summaryLimit) {
    return failedHandoffResult(result, `Result handoff workSummary exceeds the downstream limit of ${summaryLimit} characters`, [{
      path: 'workSummary', class: 'semantic', expected: `at most ${summaryLimit} characters`, got: `${draft.workSummary.length} characters`,
    }]);
  }
  const artifacts = new Set((result.artifacts ?? []).map(artifact => `${artifact.path}\u0000${artifact.digest}`));
  const invalidIndex = draft.changes.findIndex(change =>
    change.path && change.digest && !artifacts.has(`${change.path}\u0000${change.digest}`)
      && workspaceDigest(operation.workspace, change.path) !== change.digest);
  if (invalidIndex >= 0) {
    const invalid = draft.changes[invalidIndex]!;
    return failedHandoffResult(result, `Result handoff artifact reference does not match the operation result: ${invalid.path}`, [{
      path: `changes[${invalidIndex}]`, class: 'safety',
      expected: 'a path and digest that match the bytes in the work copy', got: `${invalid.path} (${invalid.digest})`,
    }]);
  }
  const invalidSharedIndex = draft.changes.findIndex(change => {
    if (!change.artifactId || change.version === undefined) return false;
    return !store.db.prepare('SELECT 1 FROM artifacts WHERE artifact_id=? AND version=?')
      .get(change.artifactId, change.version);
  });
  if (invalidSharedIndex >= 0) {
    const invalid = draft.changes[invalidSharedIndex]!;
    return failedHandoffResult(result, `Result handoff shared artifact does not exist: ${invalid.artifactId}@${invalid.version}`, [{
      path: `changes[${invalidSharedIndex}].artifactId`, class: 'safety',
      expected: 'a published artifact of this task', got: `${invalid.artifactId}@${invalid.version}`,
    }]);
  }
  const node = store.db.prepare('SELECT instance_id,activation_id,output_version FROM nodes WHERE task_id=? AND id=?')
    .get(operation.taskId, operation.nodeId) as { instance_id: string | null; activation_id: string; output_version: number };
  if (!node.instance_id || node.activation_id !== operation.activationId) {
    return failedHandoffResult(result, 'Result handoff source identity is not available');
  }
  const handoff: ResultHandoff = {
    ...draft,
    source: {
      nodeId: operation.nodeId,
      instanceId: node.instance_id,
      operationId: operation.id,
      activationId: operation.activationId,
      outputVersion: node.output_version + 1,
      operationResultDigest: operationResultDigest(result),
    },
  };
  const handoffDigest = digest(handoff);
  store.db.prepare(`INSERT INTO result_handoffs(
    id,task_id,node_id,instance_id,operation_id,activation_id,output_version,
    schema_kind,schema_version,body,digest,created_at
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    randomUUID(),
    operation.taskId,
    operation.nodeId,
    node.instance_id,
    operation.id,
    operation.activationId,
    handoff.source.outputVersion,
    DEFAULT_RESULT_SCHEMA.kind,
    DEFAULT_RESULT_SCHEMA.version,
    canonicalJson(handoff as never),
    handoffDigest,
    Date.now(),
  );
  store.event(operation.taskId, 'context.result_handoff_frozen', {
    nodeId: operation.nodeId,
    operationId: operation.id,
    activationId: operation.activationId,
    outputVersion: handoff.source.outputVersion,
    digest: handoffDigest,
  });
  return result;
}

export function renderPredecessorHandoffs(projections: PredecessorHandoffProjection[]) {
  if (!projections.length) return '';
  const lines = ['Predecessor handoffs:'];
  for (const projection of projections) {
    lines.push(`- ${projection.sourceNodeId} (${projection.mode}, operation ${projection.sourceOperationId}, output v${projection.outputVersion})`);
    if (projection.resultHandoff) {
      const handoff = projection.resultHandoff;
      lines.push(`  Work summary: ${handoff.workSummary}`);
      lines.push(`  Objective: ${handoff.objective}`);
      lines.push(`  Outcome: ${handoff.outcome}`);
      if (handoff.changes.length) lines.push(`  Changes: ${handoff.changes.map(item => item.summary).join('; ')}`);
      if (handoff.decisions.length) lines.push(`  Decisions: ${handoff.decisions.map(item => item.decision).join('; ')}`);
      if (handoff.verification.length) {
        lines.push(`  Verification: ${handoff.verification.map(item => `${item.result}: ${item.summary}`).join('; ')}`);
      }
      if (handoff.knownLimits.length) lines.push(`  Known limits: ${handoff.knownLimits.join('; ')}`);
      if (handoff.openQuestions.length) lines.push(`  Open questions: ${handoff.openQuestions.join('; ')}`);
      if (handoff.nextActions.length) lines.push(`  Next actions: ${handoff.nextActions.join('; ')}`);
    }
    if (projection.artifactRefs.length) {
      lines.push(`  Artifacts: ${projection.artifactRefs.map(item =>
        `${item.uri ?? item.path} (${item.digest})`).join('; ')}`);
    }
    if (projection.evidenceRefs.length) {
      lines.push(`  Evidence: ${projection.evidenceRefs.map(item => `${item.acceptanceId}: ${item.path} (${item.digest})`).join('; ')}`);
    }
  }
  return lines.join('\n');
}
