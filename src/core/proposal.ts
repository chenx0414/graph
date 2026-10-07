import { RuntimeError, type Proposal, type NativeProposal } from './types.ts';
import { GraphPlan } from './graph.ts';
import { validateVerifierConfig } from './verification.ts';
import { validateContextRequest } from './context.ts';
import { validatePredecessorPolicies } from './predecessor-handoff.ts';
import { parseGraphDefinition } from './interface-spec.ts';

/** Validate static structure before any node or instance is created. */
export function validateProposal(proposal: Proposal | NativeProposal) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!Number.isSafeInteger(proposal.requirementVersion) || proposal.requirementVersion < 1 || !text(proposal.summary)) invalid('A requirement version and summary are required');
  // §13.8 switchover: a draft may carry a v2 graph definition. When it does, the
  // definition IS the graph (§5), so it is validated as the definition and the old
  // declarative shape is not required. An acceptance check must then name a node or
  // module that really exists in that definition, which is the v2 spelling of
  // "a mandatory check this graph can actually run".
  if (proposal.definition !== undefined) {
    const definition = parseGraphDefinition(proposal.definition);
    if (proposal.decisions !== undefined && (!Array.isArray(proposal.decisions) || proposal.decisions.length > 50
      || proposal.decisions.some(item => typeof item !== 'string' || !item.trim() || item.length > 800))) invalid('Decisions must be a bounded list of nonempty strings');
    if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length) invalid('At least one acceptance check is required');
    if (new Set(proposal.acceptance.map(item => item.id)).size !== proposal.acceptance.length) invalid('Acceptance IDs must be unique');
    for (const item of proposal.acceptance) {
      const known = Object.hasOwn(definition.nodes, item.checkNode) || Object.hasOwn(definition.modules, item.checkNode);
      if (!text(item.id) || !text(item.description) || !known) invalid('Each acceptance item must name a node or module in the graph definition');
    }
    return;
  }
  validateLegacyProposal(proposal as Proposal);
}

function validateLegacyProposal(proposal: Proposal) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!Array.isArray(proposal.nodes) || !proposal.nodes.length || proposal.nodes.length > 1000) invalid('Expected 1–1000 nodes');
  const nodes = new Map(proposal.nodes.map(node => [node.id, node]));
  if (nodes.size !== proposal.nodes.length) invalid('Node IDs must be unique');
  if (proposal.nodes.filter(node => node.role === 'master').length > 1) invalid('Only one master is allowed');
  if (proposal.decisions !== undefined && (!Array.isArray(proposal.decisions) || proposal.decisions.length > 50
    || proposal.decisions.some(item => typeof item !== 'string' || !item.trim() || item.length > 800))) invalid('Decisions must be a bounded list of nonempty strings');
  for (const node of proposal.nodes) {
    if (!text(node.id) || !text(node.action) || !['agent', 'program'].includes(node.kind)) invalid('Invalid node identity or action');
    if (node.kind === 'agent' && (!text(node.definitionVersion) || !text(node.model))) invalid('Agents require a definition version and model');
    if (node.role !== undefined && (!['master', 'worker'].includes(node.role) || node.kind !== 'agent')) invalid('Invalid Agent role');
    if (node.context !== undefined && node.kind !== 'agent') invalid('Only Agent nodes may request a context mode');
    validateContextRequest(node.context);
    if (node.optional !== undefined && typeof node.optional !== 'boolean') invalid('Optional status must be declared as a boolean');
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) invalid('Dependencies must be a list');
    if (new Set(node.dependsOn).size !== (node.dependsOn ?? []).length) invalid('Dependencies must be unique');
    if (node.routes && (!node.routes.length || new Set(node.routes).size !== node.routes.length || node.routes.some(route => !text(route)))) invalid('Routers require unique named cases');
    if (node.deliverable !== undefined) {
      const { path, namespace, name, title, summary } = node.deliverable;
      const slug = (value: unknown) => typeof value === 'string' && /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(value.toLowerCase());
      // The path is resolved inside the node's workspace when it is published, so it must stay
      // there: a deliverable that points at an absolute path or walks out with `..` would make the
      // harness read a file the node was never entitled to hand over.
      if (!text(path) || path.startsWith('/') || path.split(/[/\\]/).some(part => part === '..' || part === '')) {
        invalid('A deliverable path must be a relative path inside the workspace');
      }
      if (!['plans', 'research', 'reviews', 'deliverables', 'summaries'].includes(namespace)) invalid('A deliverable namespace must be plans, research, reviews, deliverables or summaries');
      if (!slug(namespace) || !slug(name)) invalid('A deliverable namespace and name must be lowercase slugs');
      if (title !== undefined && !text(title)) invalid('A deliverable title must be nonempty when given');
      if (summary !== undefined && !text(summary)) invalid('A deliverable summary must be nonempty when given');
      if (title !== undefined && title.length > 300) invalid('A deliverable title is too long');
      if (summary !== undefined && summary.length > 2_000) invalid('A deliverable summary is too long');
    }
  }
  const plan = new GraphPlan(proposal);
  validatePredecessorPolicies(proposal, plan, nodes);
  for (const node of proposal.nodes) {
    const sourceNode = node.context?.sourceNode;
    if (!sourceNode) continue;
    const source = nodes.get(sourceNode);
    if (!source || source.kind !== 'agent') invalid(`Context source ${sourceNode} must be an Agent node in the same graph`);
    if (sourceNode === node.id) invalid('An Agent cannot fork from itself');
    if (!plan.ancestors(node.id).has(sourceNode)) invalid(`Context source ${sourceNode} must be a dependency ancestor of ${node.id}`);
    if ((node.context?.purpose === 'review' || node.context?.purpose === 'verify'
      || node.context?.independence && node.context.independence !== 'none')
      && node.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call')) {
      invalid('Review and independent contexts cannot inherit transcript or tool calls');
    }
  }
  validateVerifierConfig(proposal);
  if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length) invalid('At least one acceptance check is required');
  if (new Set(proposal.acceptance.map(item => item.id)).size !== proposal.acceptance.length) invalid('Acceptance IDs must be unique');
  for (const item of proposal.acceptance) {
    const check = nodes.get(item.checkNode);
    // An acceptance item may be bound to a mandatory program check, or to a mandatory Agent router:
    // when review IS the router, "this reviewer passed its own judgement" is the evidence, and
    // there is no separate program to bind to. A node that is neither (an ordinary Agent, or an
    // optional node) still cannot carry acceptance.
    const mandatory = check && !check.optional;
    const isRouter = check?.kind === 'program' || (check?.kind === 'agent' && Boolean(check.routes?.length));
    if (!text(item.id) || !text(item.description) || !mandatory || !isRouter) invalid('Each acceptance item requires an assigned mandatory program check or Agent router');
  }
}
