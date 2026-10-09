import { RuntimeError, type Json } from './types.ts';

export type PublishedSubject = { artifactId: string; version: number; digest: string };
export interface ReviewJudgment { verdict: 'pass' | 'fail' | 'unresolved'; reason: string; evidence: PublishedSubject[]; files?: string[] }
type Common = { reports: string[]; owned?: string[]; staleReview?: 'rework' | 'wait' };
/** Names refer to module input ports, never inferred node dependencies. */
export type ReviewPolicy = Common & (
  { kind: 'multiview'; subject: string; dimensions: { id: string; required: boolean; report: string }[] }
  | { kind: 'adversarial'; subject: string; criteria: string[] }
  | { kind: 'jury'; candidates: { id: string; subject: string }[]; hard: string[];
    ranking: { id: string; weight: number; min: number; max: number }[]; tieOrder: string[] }
);
export interface ReviewDecision {
  kind: 'verification'; outcome: 'pass' | 'rework'; subjects: PublishedSubject[];
  reports: string[]; blockers: { id: string; reason: string; evidence: PublishedSubject[]; files?: string[] }[];
  reviewText: { report: string; verdict: string; reason: string; files?: string[] }[];
  unowned?: string[]; ranking?: { candidateId: string; score: number; eligible: boolean }[]; winner?: string;
}

/** All configuration defects are reported before main writes/adopts the generated module. */
function validatePolicy(config: ReviewPolicy) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_definition', reason); };
  const unique = (values: string[], name: string) => {
    if (!Array.isArray(values) || !values.length || values.some(id => typeof id !== 'string' || !id.trim()) || new Set(values).size !== values.length) invalid(`${name} must be unique and nonempty`);
  };
  if (!config || typeof config !== 'object' || !['multiview', 'adversarial', 'jury'].includes(config.kind)) invalid('Unknown review policy');
  unique(config.reports, 'Review input names');
  if (config.staleReview !== undefined && !['rework', 'wait'].includes(config.staleReview)) invalid('staleReview must be rework or wait');
  if (config.owned !== undefined && (!Array.isArray(config.owned) || config.owned.some(path => typeof path !== 'string' || !path.trim() || path.startsWith('/') || path.split('/').includes('..')))) invalid('Owned scopes must be repository-relative paths');
  if (config.kind === 'multiview') {
    if (!Array.isArray(config.dimensions) || config.dimensions.some(item => !item || typeof item !== 'object')) invalid('Dimensions must be objects');
    unique(config.dimensions.map(item => item.id), 'Dimension IDs');
    for (const item of config.dimensions) if (!config.reports.includes(item.report) || typeof item.required !== 'boolean') invalid('Every dimension must declare a listed report and whether it is required');
  } else if (config.kind === 'adversarial') unique(config.criteria, 'Acceptance criteria');
  else if (config.kind === 'jury') {
    if (!Array.isArray(config.candidates) || config.candidates.some(item => !item || typeof item !== 'object')) invalid('Candidates must be objects');
    if (!Array.isArray(config.ranking) || config.ranking.some(item => !item || typeof item !== 'object')) invalid('Ranking criteria must be objects');
    unique(config.candidates.map(item => item.id), 'Candidate IDs');
    unique(config.candidates.map(item => item.subject), 'Candidate subject inputs');
    unique(config.hard, 'Hard criteria'); unique(config.ranking.map(item => item.id), 'Ranking criteria');
    unique(config.tieOrder, 'Tie order');
    if (config.tieOrder.length !== config.ranking.length || config.tieOrder.some(id => !config.ranking.some(item => item.id === id))) invalid('Tie order must be a permutation of ranking criteria');
    for (const item of config.ranking) if (![item.weight, item.min, item.max].every(Number.isFinite) || item.min >= item.max) invalid('Ranking weights and bounds must be finite with min < max');
  } else invalid('Unknown review policy');
  const subjects = config.kind === 'jury' ? config.candidates.map(item => item.subject) : [config.subject];
  unique(subjects, 'Subject input names');
  if (subjects.some(name => config.reports.includes(name))) invalid('Subject and review input names must be distinct');
}

/** Required inputs for the ordinary command-module declaration that runs this policy. */
export function reviewPolicyInputs(config: ReviewPolicy): string[] {
  validatePolicy(config);
  return [...(config.kind === 'jury' ? config.candidates.map(item => item.subject) : [config.subject]), ...config.reports];
}

/**
 * Generate a self-contained evaluate({inputs,state,trigger}) module. Main saves the
 * returned code and declares a normal versioned command module. No host imports,
 * filesystem/network access, second evaluator, or separate graph schema is needed.
 * Business rework is an output, while runtime faults retain/pause the input as usual.
 */
export function reviewPolicyCode(config: ReviewPolicy): string {
  validatePolicy(config);
  return `const policy = ${JSON.stringify(config)};\nexport function evaluate(environment) { return (${evaluatePolicy.toString()})(policy, environment.inputs, environment.state); }\n`;
}

// Keep this function closed over only its arguments: it is the isolated module body.
function evaluatePolicy(config: ReviewPolicy, inputs: Record<string, Json>, previousState: Json) {
  let waiting = false;
  const decision: ReviewDecision = { kind: 'verification', outcome: 'pass', subjects: [], reports: config.reports, blockers: [], reviewText: [] };
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
  const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim());
  const invalid = (reason: string): never => { throw new Error(reason); };
  const subject = (value: unknown): PublishedSubject => {
    if (!object(value) || !text(value.artifactId) || !Number.isSafeInteger(value.version) || Number(value.version) < 1 || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) invalid('Review requires an exact published artifact reference');
    const item = value as PublishedSubject; return { artifactId: item.artifactId, version: item.version, digest: item.digest };
  };
  const remember = (item: PublishedSubject) => { if (!decision.subjects.some(held => held.artifactId === item.artifactId && held.version === item.version && held.digest === item.digest)) decision.subjects.push(item); };
  const checkedSubject = (input: string, value: unknown) => {
    const current = subject(inputs[input]); const reviewed = subject(value);
    if (config.staleReview === 'wait' && current.artifactId === reviewed.artifactId && reviewed.version < current.version) {
      waiting = true; invalid('Waiting for review of the current published artifact version');
    }
    if (current.artifactId !== reviewed.artifactId || current.version !== reviewed.version || current.digest !== reviewed.digest) invalid('Review does not apply to the current published artifact version');
    return current;
  };
  const judgment = (value: unknown): ReviewJudgment => {
    if (!object(value) || !['pass', 'fail', 'unresolved'].includes(String(value.verdict)) || !text(value.reason) || !Array.isArray(value.evidence) || !value.evidence.length) invalid('Review judgments require verdict, reason and published evidence');
    const item = value as unknown as ReviewJudgment; item.evidence.forEach(subject);
    if (item.files !== undefined && (!Array.isArray(item.files) || !item.files.length || item.files.some(path => !text(path) || path.startsWith('/') || path.split('/').includes('..')))) invalid('Review files must be nonempty repository-relative paths');
    return item;
  };
  const block = (id: string, item: ReviewJudgment) => decision.blockers.push({ id, reason: item.reason, evidence: item.evidence, ...(item.files ? { files: item.files } : {}) });
  const summarize = (report: string, items: ReviewJudgment[]) => {
    const selected = items.find(item => item.verdict !== 'pass') ?? items[0]; if (!selected) return;
    const files = [...new Set(items.flatMap(item => item.files ?? []))];
    decision.reviewText.push({ report, verdict: selected.verdict, reason: selected.reason, ...(files.length ? { files } : {}) });
  };
  try {
    const reports = config.reports.map(name => {
      const value = inputs[name];
      if (!object(value) || value.schemaVersion !== 1 || !object(value.body) || value.body.kind !== config.kind) invalid(`Missing or malformed review report from ${name}`);
      const report = value as unknown as { subject: unknown; body: Record<string, unknown> };
      return { name, subject: report.subject, body: report.body };
    });
    if (config.kind === 'multiview') {
      for (const report of reports) {
        remember(checkedSubject(config.subject, report.subject));
        if (!object(report.body.dimensions)) invalid('Review dimensions are required');
        const dimensions = report.body.dimensions as Record<string, unknown>; const judged: ReviewJudgment[] = [];
        for (const item of config.dimensions.filter(item => item.report === report.name)) {
          if (dimensions[item.id] === undefined && !item.required) continue;
          const checked = judgment(dimensions[item.id]); judged.push(checked);
          if (item.required && checked.verdict !== 'pass') block(item.id, checked);
        }
        summarize(report.name, judged);
      }
    } else if (config.kind === 'adversarial') {
      const checks: Record<string, unknown> = Object.create(null); const counterexamples: unknown[] = [];
      for (const report of reports) {
        remember(checkedSubject(config.subject, report.subject));
        if (!object(report.body.checks) || !Array.isArray(report.body.counterexamples)) invalid('Adversarial review requires checks and counterexamples');
        Object.assign(checks, report.body.checks); counterexamples.push(...report.body.counterexamples as unknown[]);
        summarize(report.name, Object.values(report.body.checks as Record<string, unknown>).map(judgment));
      }
      for (const id of config.criteria) { const checked = judgment(checks[id]); if (checked.verdict !== 'pass') block(id, checked); }
      const seen = new Set<string>();
      for (const raw of counterexamples) {
        if (!object(raw) || !text(raw.id) || seen.has(raw.id) || !text(raw.acceptanceId) || !config.criteria.includes(raw.acceptanceId)
          || typeof raw.impactsAcceptance !== 'boolean' || !['valid', 'invalid', 'unresolved'].includes(String(raw.validity)) || !['open', 'resolved'].includes(String(raw.resolution))) invalid('Counterexamples require unique IDs, configured criteria, validity, resolution and acceptance impact');
        const item = raw as Record<string, unknown>; seen.add(item.id as string); const checked = judgment(item.judgment);
        if (item.impactsAcceptance && item.resolution === 'open' && item.validity !== 'invalid') block(item.id as string, checked);
      }
    } else {
      const entries = new Map<string, { artifact: PublishedSubject; eligible: boolean; scores: Record<string, number> }>();
      for (const report of reports) {
        if (!Array.isArray(report.body.candidates)) invalid('Jury report requires candidates');
        for (const raw of report.body.candidates as unknown[]) {
          if (!object(raw) || !text(raw.id) || entries.has(raw.id)) invalid('Jury report must include each candidate once');
          const item = raw as Record<string, unknown>; const candidate = config.candidates.find(spec => spec.id === item.id);
          if (!candidate || !object(item.hard) || !object(item.scores)) invalid('Jury candidates require configured IDs, hard judgments and scores');
          const artifact = checkedSubject(candidate!.subject, item.artifact); const hard = item.hard as Record<string, unknown>; const rawScores = item.scores as Record<string, unknown>;
          const eligible = config.hard.map(id => judgment(hard[id])).every(item => item.verdict === 'pass'); const scores: Record<string, number> = {};
          for (const criterion of config.ranking) {
            const rawScore = rawScores[criterion.id];
            if (!object(rawScore) || typeof rawScore.value !== 'number' || !Number.isFinite(rawScore.value) || rawScore.value < criterion.min || rawScore.value > criterion.max) invalid('Jury scores must fall within the configured bounds');
            const score = rawScore as { value: number; reason: string; evidence: PublishedSubject[] }; judgment({ ...score, verdict: 'pass' }); scores[criterion.id] = score.value;
          }
          entries.set(item.id as string, { artifact, eligible, scores });
        }
      }
      const ranked = config.candidates.map(candidate => {
        const entry = entries.get(candidate.id); if (!entry) invalid('Jury report must include every candidate');
        const score = config.ranking.reduce((total, criterion) => total + criterion.weight * (entry!.scores[criterion.id]! - criterion.min) / (criterion.max - criterion.min), 0);
        return { candidateId: candidate.id, score, ...entry! };
      });
      decision.ranking = ranked.map(({ candidateId, score, eligible }) => ({ candidateId, score, eligible }));
      const eligible = ranked.filter(item => item.eligible).sort((left, right) => {
        if (right.score !== left.score) return right.score - left.score;
        for (const id of config.tieOrder) { const difference = right.scores[id]! - left.scores[id]!; if (difference) return difference; }
        return left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0;
      });
      const winner = eligible[0];
      if (!winner) decision.blockers.push({ id: 'winner', reason: 'No candidate satisfies the hard criteria', evidence: [] });
      else { decision.winner = winner.candidateId; remember(winner.artifact); }
    }
  } catch (error) {
    if (waiting) return { state: previousState, outputs: {}, diagnostics: ['Waiting for review of the current published artifact version'] };
    decision.blockers.push({ id: 'invalid_evidence', reason: error instanceof Error ? error.message : String(error), evidence: [] });
    // Invalid evidence must not leave a partial jury winner looking accepted.
    delete decision.winner;
  }
  decision.outcome = decision.blockers.length ? 'rework' : 'pass';
  const unowned = [...new Set(decision.blockers.flatMap(item => item.files ?? []))].filter(path => !(config.owned ?? []).some(scope => path === scope || path.startsWith(scope.endsWith('/') ? scope : `${scope}/`)));
  if (unowned.length) decision.unowned = unowned;
  return { state: { decision }, outputs: { [decision.outcome === 'pass' ? 'approved' : 'rework']: decision }, diagnostics: [`${config.kind}: ${decision.outcome}`] };
}
