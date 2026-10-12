import { parseGraphDefinition, type GraphDefinition } from '../core/interface-spec.ts';
import { RuntimeError } from '../core/types.ts';
import type { AgentCombination } from './agent-combinations.ts';
import type { Catalog } from './catalog.ts';

const skill = (name: string) => `mattpocock-skills-skills-engineering-${name}`;
const roles = ['planner', 'worker', 'standards', 'spec'] as const;
type Role = typeof roles[number];

export interface MattTeamOptions {
  name: string;
  task: string;
  spec: string;
  ticket: number;
  baseRef: string;
  check: { command: string; args: string[]; timeoutMs?: number };
  /** Keep the prefix stable to reuse the same role recipes across tasks. */
  recipePrefix?: string;
  models?: Partial<Record<Role, string>>;
  /** Main writes task-specific instructions with writing-for-agents. */
  instructions?: Partial<Record<Role, string>>;
}

type TeamCatalog = Pick<Catalog, 'capability' | 'saveAgentCombination'>;

/** Assemble published role recipes and return an ordinary, persistable v2 definition. */
export async function assembleMattTeam(catalog: TeamCatalog, options: MattTeamOptions): Promise<GraphDefinition> {
  for (const key of ['name', 'task', 'spec', 'baseRef'] as const) {
    if (!options[key]?.trim()) throw new RuntimeError('invalid_input', `Matt team ${key} must be nonempty`);
  }
  if (!Number.isSafeInteger(options.ticket) || options.ticket < 1) throw new RuntimeError('invalid_input', 'Matt team ticket must be a positive integer');
  const prefix = options.recipePrefix ?? 'matt-team';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(prefix)) throw new RuntimeError('invalid_input', 'Matt recipePrefix must be a lowercase slug');
  const bindings: Record<Role, string[]> = {
    planner: [skill('codebase-design')], worker: [skill('tdd')], standards: [skill('code-review')], spec: [skill('code-review')],
  };
  const versions = new Map<string, string>();
  const missing: string[] = [];
  for (const role of roles) for (const id of bindings[role]) {
    const resource = catalog.capability(id);
    if (!resource || resource.kind !== 'skill' || resource.status !== 'available') missing.push(`${role}: ${id}`);
    else versions.set(id, resource.version);
  }
  if (missing.length) throw new RuntimeError('missing_capability', `Matt team requires available skills before assembly:\n${missing.join('\n')}`);

  const context = `Task: ${options.task}\nApproved specification: ${options.spec}\nTicket: #${options.ticket}\nFixed review base: ${options.baseRef}`;
  const instructions: Record<Role, string> = {
    planner: `${context}\nRead the project AGENTS.md, CODING_STANDARDS.md, CONTEXT.md and relevant ADRs. Read the bound /codebase-design skill when choosing implementation seams. Preserve the approved specification and ticket; do not interview again or invent new scope. Where the project uses Matt's mechanical flow, run its tickets stage before first implementation, never implement as an opening gate. Publish a plan artifact containing the ordered implementation slices, approved acceptance and checks, affected seams and skill requirements. Submit result with the exact plan {artifactId,version,digest}, specification, ticket and fixed base. Done means the immutable plan has been published and submitted.`,
    worker: `${context}\nRead the delivered exact plan with artifact_read; check its digest and implement only that plan in this original worker worktree. Read the bound /tdd skill and project testing instructions before tests, driving each agreed slice red then green. On rework read both exact report references, retain the original plan, and fix the reported failures in this same node/session. Run project checks before workspace_commit; reference the ticket in the commit message. Publish committed implementation files or a manifest of exact code artifacts using metadata.kind=code. Submit result with plan, subject {artifactId,version,digest}, source commit and evidence. Review is performed by the existing Standards and Spec graph peers; do not spawn nested agents or create graphs. Done means committed implementation and immutable references are submitted, not final delivery.`,
    standards: `${context}\nRead the bound /code-review skill. You are its independent Standards axis, already dispatched by main alongside the Spec peer; do not call spawn or create a graph. Read the exact delivered plan and subject with artifact_read, check digests, and inspect the actual current integration worktree and its HEAD against the fixed base. Apply all project standards and the skill's smell baseline, skipping mechanically enforced rules. Never change code. Publish a graph.review@1 JSON report containing current integration commit, passed, reason, plan, subject, axis and file/line or reproducible evidence. The delivered private source commit is provenance, not the final integration SHA. Submit result containing the same plan/subject, report {artifactId,version,digest}, commit, passed and reason. Done means this exact version has a published independent report; do not declare graph completion.`,
    spec: `${context}\nRead the bound /code-review skill. You are its independent Spec axis, already dispatched by main alongside the Standards peer; do not call spawn or create a graph. Read the exact delivered plan and subject with artifact_read, check digests, and inspect the actual current integration worktree and its HEAD against the fixed base. Compare every approved acceptance with the actual diff: missing/partial requirements, wrong behavior and scope creep; cite specification and reproducible evidence. Never change code. Publish a graph.review@1 JSON report containing current integration commit, passed, reason, plan, subject, axis and evidence. The private source commit is provenance, not the final integration SHA. Submit result containing the same plan/subject, report {artifactId,version,digest}, commit, passed and reason. Done means this exact version has a published independent report; do not declare graph completion.`,
  };
  const identity: Record<Role, string> = {
    planner: 'Plan an approved ticket into explicit, verifiable implementation slices. Publish immutable plans; do not implement or approve delivery.',
    worker: 'Implement the delivered immutable plan and process review feedback in this same worktree and session. Never substitute self-review for the independent graph review peers.',
    standards: 'Independent, read-only Standards reviewer. Follow the Standards axis of code-review using the graph peers already arranged by main. Do not spawn agents.',
    spec: 'Independent, read-only Spec reviewer. Follow the Spec axis of code-review using the graph peers already arranged by main. Do not spawn agents.',
  };
  const reference = { type: 'object', required: ['artifactId', 'version', 'digest'], properties: { artifactId: { type: 'string', minLength: 1 }, version: { type: 'integer', minimum: 1 }, digest: { type: 'string', minLength: 1 } } };
  const data = { protocol: 'data' };
  const handoff = { protocol: 'handoff' };
  const review = { protocol: 'review' };
  const candidate = { protocol: 'candidate' };
  const definitions: Record<Role, string> = Object.fromEntries(roles.map(role => [role, `${prefix}-${role}@1`])) as Record<Role, string>;
  const create = () => parseGraphDefinition({ schemaVersion: 2, name: options.name,
    protocols: {
      data: { type: 'object' },
      handoff: { type: 'object', required: ['plan'], properties: { plan: reference, subject: reference } },
      candidate: { type: 'object', required: ['plan', 'subject'], properties: { plan: reference, subject: reference } },
      review: { type: 'object', required: ['plan', 'subject', 'report', 'commit', 'passed', 'reason'], properties: {
        plan: reference, subject: reference, report: reference, commit: { type: ['string', 'null'] }, passed: { type: 'boolean' }, reason: { type: 'string', minLength: 1 },
      } },
    },
    nodes: Object.fromEntries(roles.map(role => [role, {
      recipe: definitions[role], ...(options.models?.[role] ? { model: options.models[role] } : {}), task: `${role}: ${options.task}`,
      instructions: options.instructions?.[role] ?? instructions[role],
      inputs: { job: role === 'planner' ? data : role === 'worker' ? handoff : candidate }, outputs: { result: role === 'standards' || role === 'spec' ? review : role === 'worker' ? candidate : handoff }, submission: { required: ['result'] },
    }])),
    modules: {
      decision: { type: 'router', trigger: 'each', requiredInputs: ['standards', 'spec'], inputs: { standards: review, spec: review }, outputs: { rework: handoff, approved: data },
        rules: ['false', 'true'].map(passed => ({
          when: `standards.subject.artifactId == spec.subject.artifactId && standards.subject.version == spec.subject.version && standards.subject.digest == spec.subject.digest && standards.plan.artifactId == spec.plan.artifactId && standards.plan.version == spec.plan.version && standards.plan.digest == spec.plan.digest && standards.commit == spec.commit && ${passed === 'false' ? '(standards.passed == false || spec.passed == false)' : 'standards.passed == true && spec.passed == true'}`,
          emit: { [passed === 'false' ? 'rework' : 'approved']: { plan: 'standards.plan', subject: 'standards.subject', commit: 'standards.commit', standards: '$standards', spec: '$spec', passed: passed === 'true' } },
        })),
      },
      check: { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: {
        action: 'workspace.command', version: 1, command: options.check.command, args: options.check.args, output: 'result', timeoutMs: options.check.timeoutMs ?? 300_000,
      } },
    },
    edges: {
      planned: { from: 'planner.result', to: 'worker.job', enabled: true },
      standards: { from: 'worker.result', to: 'standards.job', enabled: true }, spec: { from: 'worker.result', to: 'spec.job', enabled: true },
      'standards-report': { from: 'standards.result', to: 'decision.standards', enabled: true }, 'spec-report': { from: 'spec.result', to: 'decision.spec', enabled: true },
      rework: { from: 'decision.rework', to: 'worker.job', enabled: true },
    },
    inputs: { job: { to: 'planner.job', ...data }, check: { to: 'check.job', ...data } }, outputs: { result: { from: 'decision.approved', ...data } },
    acceptance: [{ id: 'check', description: 'Project checks pass on the current clean integration commit', kind: 'check', module: 'check' },
      ...(['standards', 'spec'] as const).map(role => ({ id: role, description: `Independent ${role} review of the current integration commit`, kind: 'review', node: role }))],
  });
  create(); // Validate all caller-supplied configuration before writing any recipes.
  for (const role of roles) {
    const combination: AgentCombination = { id: `${prefix}-${role}`, name: `Matt ${role}`, description: identity[role], recommendedGrade: 'medium', review: role === 'standards' || role === 'spec',
      tags: ['matt-team', role], systemPrompt: identity[role], resources: bindings[role].map(resourceId => ({ resourceId, version: versions.get(resourceId)!, role: 'skill', required: true })) };
    const result = await catalog.saveAgentCombination(combination);
    if (!result.definition) throw new RuntimeError('invalid_agent_combination', result.compileError ?? `Matt ${role} did not compile`);
    definitions[role] = result.definition.definitionVersion;
  }
  return create();
}
