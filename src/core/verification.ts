import { isAbsolute } from 'node:path';
import { GraphPlan } from './graph.ts';
import { canonicalJson } from './store.ts';
import { RuntimeError, type ArtifactVersion, type DependencySource, type Json, type OperationResult, type Proposal } from './types.ts';

export type Proof = { path: string; digest: string };
export type Judgment = { verdict: 'pass' | 'fail' | 'unresolved'; reason: string; evidence: Proof[] };
type CommonConfig = { reportNodes: string[] };
export type VerifierConfig = CommonConfig & (
  | { kind: 'adversarial'; subjectNode: string; acceptanceCriteria: string[] }
  | { kind: 'multiview'; subjectNode: string; dimensions: { id: string; required: boolean; reportNode: string }[] }
  | { kind: 'jury'; candidates: { id: string; node: string }[]; hardCriteria: string[];
      ranking: { id: string; weight: number; min: number; max: number }[]; tieOrder: string[];
      revalidate?: { selectionNode: string; subjectNode: string } }
);
export type ReviewReport = { schemaVersion: 1 } & (
  | { subject: ArtifactVersion; body: { kind: 'multiview'; dimensions: Record<string, Judgment> } }
  | { subject: ArtifactVersion; body: { kind: 'adversarial'; checks: Record<string, Judgment>;
      counterexamples: { id: string; acceptanceId: string; validity: 'valid' | 'invalid' | 'unresolved'; impactsAcceptance: boolean;
        resolution: 'open' | 'resolved'; judgment: Judgment }[] } }
  | { body: { kind: 'jury'; candidates: { id: string; artifact: ArtifactVersion; hard: Record<string, Judgment>;
      scores: Record<string, { value: number; reason: string; evidence: Proof[] }> }[] } }
);
type Source = Pick<DependencySource, 'nodeId' | 'operationId' | 'activationId'>;
export type VerificationDecision = { kind: 'verification'; outcome: 'pass' | 'rework'; subjects: ArtifactVersion[];
  reports: Source[]; blockers: { id: string; reason: string; evidence: Proof[] }[];
  ranking?: { candidateId: string; score: number; eligible: boolean }[]; winner?: string };
export type VerificationContext = { dependencies: Record<string, Json>; dependencySources: Record<string, DependencySource[]>; acceptanceIds: string[] };
function invalid(reason: string): never { throw new RuntimeError('invalid_evidence', reason); }
function invalidProposal(reason: string): never { throw new RuntimeError('invalid_proposal', reason); }
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
const proof = (value: unknown): value is Proof => record(value) && typeof value.path === 'string' && isAbsolute(value.path) && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest);
function unique(ids: string[], label: string) {
  if (!ids.length || ids.some(id => !id.trim()) || new Set(ids).size !== ids.length) invalidProposal(`${label} must be unique and nonempty`);
}
function judgment(value: unknown): Judgment {
  if (!record(value) || !['pass', 'fail', 'unresolved'].includes(String(value.verdict)) || !nonempty(value.reason)
      || !Array.isArray(value.evidence) || !value.evidence.length || !value.evidence.every(proof)) invalid('Review judgments require a verdict, reason and evidence');
  return value as Judgment;
}
function source(context: VerificationContext, node: string): DependencySource {
  const sources = context.dependencySources[node];
  if (!sources || sources.length !== 1 || sources[0]!.nodeId !== node || !nonempty(sources[0]!.operationId) || !nonempty(sources[0]!.activationId)) invalid(`Missing current source for ${node}`);
  return sources[0]!;
}
function artifactVersion(value: unknown): ArtifactVersion {
  if (!record(value) || !nonempty(value.id) || !nonempty(value.path) || !nonempty(value.digest) || !nonempty(value.nodeId)
      || !nonempty(value.operationId) || !nonempty(value.activationId) || !isAbsolute(value.path) || !/^[a-f0-9]{64}$/.test(value.digest)) {
    invalid('Report requires an exact artifact version');
  }
  return { id: value.id, path: value.path, digest: value.digest, nodeId: value.nodeId, operationId: value.operationId, activationId: value.activationId };
}
function sameArtifact(left: ArtifactVersion, right: ArtifactVersion) {
  return left.id === right.id && left.path === right.path && left.digest === right.digest
    && left.nodeId === right.nodeId && left.operationId === right.operationId && left.activationId === right.activationId;
}
function subject(context: VerificationContext, node: string, value: unknown): ArtifactVersion {
  const reported = artifactVersion(value);
  const artifact = source(context, node).artifacts.find(item => sameArtifact(item, reported));
  if (!artifact) invalid('Review does not apply to the current artifact version');
  return artifact;
}
function reachable(plan: GraphPlan, from: string, target: string) {
  return new Set(plan.dependencies.get(from)!.flatMap(id => [id, ...plan.leaves(id)])).has(target);
}

/** Structural checks for program-owned verifier gates. GraphPlan already verified the DAG. */
export function validateVerifierConfig(proposal: Proposal) {
  const plan = new GraphPlan(proposal);
  for (const node of plan.nodes.values()) {
    if (node.action === 'graph.verify' || node.verifier) {
      if (node.kind !== 'program' || node.action !== 'graph.verify' || !node.verifier) invalidProposal('Verifier config is only valid on graph.verify program nodes');
      if (node.optional) invalidProposal('Verifier gates must be mandatory');
    }
  }
  for (const node of plan.nodes.values()) {
    const config = node.verifier;
    if (!config) continue;
    unique(config.reportNodes, 'Report nodes');
    for (const report of config.reportNodes) {
      if (!plan.nodes.has(report) || !reachable(plan, node.id, report)) invalidProposal('Verifier reports must be current dependencies');
    }
    if (config.kind === 'multiview') {
      unique(config.dimensions.map(dimension => dimension.id), 'Dimensions');
      if (!plan.nodes.has(config.subjectNode) || !reachable(plan, node.id, config.subjectNode)) invalidProposal('Verifier subject must be a dependency');
      for (const dimension of config.dimensions) {
        if (!config.reportNodes.includes(dimension.reportNode)) invalidProposal('Dimension reportNode must be listed in reportNodes');
      }
    } else if (config.kind === 'adversarial') {
      unique(config.acceptanceCriteria, 'Acceptance criteria');
      if (!plan.nodes.has(config.subjectNode) || !reachable(plan, node.id, config.subjectNode)) invalidProposal('Verifier subject must be a dependency');
      const accepted = new Set(proposal.acceptance.map(item => item.id));
      if (config.acceptanceCriteria.some(id => !accepted.has(id))) invalidProposal('Adversarial criteria must refer to confirmed acceptance items');
    } else {
      unique(config.candidates.map(candidate => candidate.id), 'Candidates');
      unique(config.candidates.map(candidate => candidate.node), 'Candidate nodes');
      unique(config.hardCriteria, 'Hard criteria');
      unique(config.ranking.map(criterion => criterion.id), 'Ranking criteria');
      if (config.tieOrder.length !== config.ranking.length || new Set(config.tieOrder).size !== config.tieOrder.length
          || config.tieOrder.some(id => !config.ranking.some(criterion => criterion.id === id))) invalidProposal('Tie order must be a permutation of ranking criteria');
      for (const candidate of config.candidates) {
        if (!plan.nodes.has(candidate.node) || !reachable(plan, node.id, candidate.node)) invalidProposal('Candidates must be dependencies');
      }
      for (const criterion of config.ranking) {
        if (![criterion.weight, criterion.min, criterion.max].every(value => typeof value === 'number' && Number.isFinite(value)) || criterion.max <= criterion.min) {
          invalidProposal('Ranking weights and bounds must be finite with min < max');
        }
      }
      const revalidate = config.revalidate;
      if (revalidate) {
        const selection = plan.nodes.get(revalidate.selectionNode);
        if (selection?.verifier?.kind !== 'jury' || !reachable(plan, node.id, revalidate.selectionNode)) invalidProposal('Revalidation must depend on the preceding jury gate');
        if (!reachable(plan, node.id, revalidate.subjectNode)) invalidProposal('Revalidation must depend on the absorbed artifact');
        if (!reachable(plan, revalidate.subjectNode, revalidate.selectionNode)) invalidProposal('Absorb node must depend on the selection gate');
        const previous = selection.verifier;
        if (previous.kind !== 'jury' || canonicalJson(previous.hardCriteria) !== canonicalJson(config.hardCriteria)
            || canonicalJson(previous.ranking) !== canonicalJson(config.ranking) || canonicalJson(previous.tieOrder) !== canonicalJson(config.tieOrder)) {
          invalidProposal('Revalidation must use the same jury rules as the selection gate');
        }
        if (!proposal.acceptance.some(item => item.checkNode === node.id)) invalidProposal('Final acceptance must point at the revalidation gate');
        if (proposal.acceptance.some(item => item.checkNode === revalidate.selectionNode)) invalidProposal('Selection gate cannot be the final acceptance when revalidation exists');
      }
    }
  }
}

export function isReworkDecision(output: Json): boolean {
  return output !== null && typeof output === 'object' && !Array.isArray(output) && output.kind === 'verification' && output.outcome === 'rework';
}

function collectReports(config: VerifierConfig, context: VerificationContext, decision: VerificationDecision) {
  return config.reportNodes.map(node => {
    const current = source(context, node);
    decision.reports.push({ nodeId: current.nodeId, operationId: current.operationId, activationId: current.activationId });
    const report = context.dependencies[node];
    if (!record(report) || report.schemaVersion !== 1 || !record(report.body) || report.body.kind !== config.kind) invalid(`Missing or malformed review report from ${node}`);
    return { node, body: report.body, subject: report.subject };
  });
}

function remember(decision: VerificationDecision, artifact: ArtifactVersion) {
  if (!decision.subjects.some(item => item.id === artifact.id && item.activationId === artifact.activationId)) decision.subjects.push(artifact);
}

function evaluateMultiview(config: Extract<VerifierConfig, { kind: 'multiview' }>, context: VerificationContext, reports: ReturnType<typeof collectReports>, decision: VerificationDecision) {
  for (const report of reports) {
    remember(decision, subject(context, config.subjectNode, report.subject));
    if (!record(report.body.dimensions)) invalid('Review dimensions are required');
    for (const dimension of config.dimensions.filter(item => item.reportNode === report.node)) {
      const raw = report.body.dimensions[dimension.id];
      if (raw === undefined) {
        if (dimension.required) invalid(`Missing required dimension ${dimension.id}`);
        continue;
      }
      const checked = judgment(raw);
      if (dimension.required && checked.verdict !== 'pass') decision.blockers.push({ id: dimension.id, reason: checked.reason, evidence: checked.evidence });
    }
  }
}

function evaluateAdversarial(config: Extract<VerifierConfig, { kind: 'adversarial' }>, context: VerificationContext, reports: ReturnType<typeof collectReports>, decision: VerificationDecision) {
  const checks: Record<string, unknown> = {};
  const counterexamples: unknown[] = [];
  for (const report of reports) {
    remember(decision, subject(context, config.subjectNode, report.subject));
    if (!record(report.body.checks) || !Array.isArray(report.body.counterexamples)) invalid('Adversarial review requires checks and counterexamples');
    Object.assign(checks, report.body.checks);
    counterexamples.push(...report.body.counterexamples);
  }
  for (const criterion of config.acceptanceCriteria) {
    const checked = judgment(checks[criterion]);
    if (checked.verdict !== 'pass') decision.blockers.push({ id: criterion, reason: checked.reason, evidence: checked.evidence });
  }
  const seen = new Set<string>();
  for (const item of counterexamples) {
    if (!record(item) || !nonempty(item.id) || seen.has(item.id) || !nonempty(item.acceptanceId) || typeof item.impactsAcceptance !== 'boolean'
        || !['valid', 'invalid', 'unresolved'].includes(String(item.validity)) || !['open', 'resolved'].includes(String(item.resolution))) {
      invalid('Counterexamples require unique IDs, validity, resolution and acceptance impact');
    }
    seen.add(item.id);
    if (!config.acceptanceCriteria.includes(item.acceptanceId)) invalid('Counterexample must refer to a configured acceptance criterion');
    const judged = judgment(item.judgment);
    if (item.impactsAcceptance && item.resolution === 'open' && item.validity !== 'invalid') {
      decision.blockers.push({ id: item.id, reason: judged.reason, evidence: judged.evidence });
    }
  }
}

function evaluateJury(config: Extract<VerifierConfig, { kind: 'jury' }>, context: VerificationContext, reports: ReturnType<typeof collectReports>, decision: VerificationDecision) {
  const entries: Record<string, { id: string; artifact: ArtifactVersion; scores: Record<string, number>; eligible: boolean }> = {};
  for (const report of reports) {
    if (!Array.isArray(report.body.candidates)) invalid('Jury report requires candidates');
    for (const item of report.body.candidates) {
      if (!record(item) || !nonempty(item.id) || entries[item.id]) invalid('Jury report must include each candidate once');
      const spec = config.candidates.find(candidate => candidate.id === item.id);
      if (!spec) invalid('Jury report refers to an unknown candidate');
      const node = config.revalidate?.subjectNode ?? spec.node;
      const artifact = subject(context, node, item.artifact);
      if (!record(item.hard) || !record(item.scores)) invalid('Jury candidates require hard judgments and scores');
      let eligible = true;
      for (const criterion of config.hardCriteria) {
        const judged = judgment(item.hard[criterion]);
        if (judged.verdict !== 'pass') {
          eligible = false;
          decision.blockers.push({ id: `${item.id}:${criterion}`, reason: judged.reason, evidence: judged.evidence });
        }
      }
      const scores: Record<string, number> = {};
      for (const criterion of config.ranking) {
        const score = item.scores[criterion.id];
        if (!record(score) || typeof score.value !== 'number' || !Number.isFinite(score.value) || score.value < criterion.min || score.value > criterion.max
            || !nonempty(score.reason) || !Array.isArray(score.evidence) || !score.evidence.length || !score.evidence.every(proof)) {
          invalid('Jury scores must fall within the confirmed bounds and include evidence');
        }
        scores[criterion.id] = score.value;
      }
      entries[item.id] = { id: item.id, artifact, scores, eligible };
    }
  }
  if (config.candidates.some(candidate => !entries[candidate.id])) invalid('Jury report must include every candidate');
  const ranked = config.candidates.map(candidate => {
    const entry = entries[candidate.id]!;
    const score = config.ranking.reduce((total, criterion) => total + criterion.weight * (entry.scores[criterion.id]! - criterion.min) / (criterion.max - criterion.min), 0);
    return { candidateId: candidate.id, score, eligible: entry.eligible, scores: entry.scores, artifact: entry.artifact };
  });
  decision.ranking = ranked.map(item => ({ candidateId: item.candidateId, score: item.score, eligible: item.eligible }));
  const eligible = ranked.filter(item => item.eligible).sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    for (const id of config.tieOrder) {
      const delta = right.scores[id]! - left.scores[id]!;
      if (delta) return delta;
    }
    return left.candidateId < right.candidateId ? -1 : 1;
  });
  if (!eligible.length) {
    decision.blockers.push({ id: 'winner', reason: 'No candidate satisfies the hard criteria', evidence: [] });
    return;
  }
  const winner = eligible[0]!;
  decision.winner = winner.candidateId;
  remember(decision, winner.artifact);
}

/** Program-owned rules consume the current operation's persisted dependency snapshot. */
export function evaluateVerifier(config: VerifierConfig, context: VerificationContext): OperationResult {
  const decision: VerificationDecision = { kind: 'verification', outcome: 'pass', subjects: [], reports: [], blockers: [] };
  const reports = collectReports(config, context, decision);
  if (config.kind === 'multiview') evaluateMultiview(config, context, reports, decision);
  else if (config.kind === 'adversarial') evaluateAdversarial(config, context, reports, decision);
  else evaluateJury(config, context, reports, decision);
  decision.outcome = decision.blockers.length ? 'rework' : 'pass';
  const artifact = decision.subjects[0];
  if (decision.outcome === 'pass' && !artifact) invalid('Verifier requires an artifact');
  return { outcome: 'completed', output: decision as unknown as Json,
    ...(decision.outcome === 'pass' ? { evidence: context.acceptanceIds.map(acceptanceId => ({ acceptanceId, summary: `Required ${config.kind} judgments passed`, artifact: { path: artifact!.path, digest: artifact!.digest } })) } : {}),
  };
}
