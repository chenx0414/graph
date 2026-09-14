import { RuntimeError, type Proposal } from './types.ts';
import { GraphPlan } from './graph.ts';
import { validateVerifierConfig } from './verification.ts';

/** Validate static structure before any node or instance is created. */
export function validateProposal(proposal: Proposal) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!Number.isSafeInteger(proposal.requirementVersion) || proposal.requirementVersion < 1 || !text(proposal.summary)) invalid('A requirement version and summary are required');
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
    if (node.optional !== undefined && typeof node.optional !== 'boolean') invalid('Optional status must be declared as a boolean');
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) invalid('Dependencies must be a list');
    if (new Set(node.dependsOn).size !== (node.dependsOn ?? []).length) invalid('Dependencies must be unique');
    if (node.routes && (node.kind !== 'program' || !node.routes.length || new Set(node.routes).size !== node.routes.length || node.routes.some(route => !text(route)))) invalid('Routers require unique named cases');
  }
  new GraphPlan(proposal);
  validateVerifierConfig(proposal);
  if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length) invalid('At least one acceptance check is required');
  if (new Set(proposal.acceptance.map(item => item.id)).size !== proposal.acceptance.length) invalid('Acceptance IDs must be unique');
  for (const item of proposal.acceptance) {
    if (!text(item.id) || !text(item.description) || nodes.get(item.checkNode)?.kind !== 'program' || nodes.get(item.checkNode)?.optional) invalid('Each acceptance item requires an assigned mandatory program check');
  }
}
