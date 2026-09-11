import { RuntimeError, type Proposal } from './types.ts';

/** M1 accepts fixed DAGs. Versioned routing, loops and containers arrive in M2. */
export function validateProposal(proposal: Proposal) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!Number.isSafeInteger(proposal.requirementVersion) || proposal.requirementVersion < 1 || !text(proposal.summary)) invalid('A requirement version and summary are required');
  if (!Array.isArray(proposal.nodes) || !proposal.nodes.length || proposal.nodes.length > 1000) invalid('Expected 1–1000 nodes');
  const nodes = new Map(proposal.nodes.map(node => [node.id, node]));
  if (nodes.size !== proposal.nodes.length) invalid('Node IDs must be unique');
  if (proposal.nodes.filter(node => node.role === 'master').length > 1) invalid('Only one master is allowed');
  for (const node of proposal.nodes) {
    if (!text(node.id) || !text(node.action) || !['agent', 'program'].includes(node.kind)) invalid('Invalid node identity or action');
    if (node.kind === 'agent' && (!text(node.definitionVersion) || !text(node.model))) invalid('Agents require a definition version and model');
    if (node.role !== undefined && (!['master', 'worker'].includes(node.role) || node.kind !== 'agent')) invalid('Invalid Agent role');
    if (node.dependsOn !== undefined && !Array.isArray(node.dependsOn)) invalid('Dependencies must be a list');
    if ((node.dependsOn ?? []).some(id => !nodes.has(id)) || new Set(node.dependsOn).size !== (node.dependsOn ?? []).length) invalid('Dependencies must be unique existing nodes');
  }
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string) => {
    if (visiting.has(id)) invalid('M1 graphs cannot contain cycles');
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of nodes.get(id)!.dependsOn ?? []) visit(dependency);
    visiting.delete(id); visited.add(id);
  };
  for (const id of nodes.keys()) visit(id);
  if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length) invalid('At least one acceptance check is required');
  if (new Set(proposal.acceptance.map(item => item.id)).size !== proposal.acceptance.length) invalid('Acceptance IDs must be unique');
  for (const item of proposal.acceptance) {
    if (!text(item.id) || !text(item.description) || nodes.get(item.checkNode)?.kind !== 'program') invalid('Each acceptance item requires an assigned program check');
  }
}
