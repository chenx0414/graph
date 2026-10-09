import { RuntimeError, type NativeProposal } from './types.ts';
import { parseGraphDefinition } from './interface-spec.ts';

/** Validate static structure before any node or instance is created. */
export function validateProposal(proposal: NativeProposal) {
  const invalid = (reason: string): never => { throw new RuntimeError('invalid_proposal', reason); };
  const text = (value: unknown) => typeof value === 'string' && value.trim().length > 0;
  if (!Number.isSafeInteger(proposal.requirementVersion) || proposal.requirementVersion < 1 || !text(proposal.summary)) invalid('A requirement version and summary are required');
  // The native definition owns executable acceptance. The confirmation summary
  // must describe those same criteria, so invalid drafts fail before confirmation.
  if (proposal.definition === undefined) invalid('A native graph definition is required; legacy DAG drafts are retired');
  const legacy = ['nodes', 'loops', 'containers'].filter(field => Object.hasOwn(proposal, field));
  if (legacy.length) invalid(`Native drafts use definition only; remove legacy fields: ${legacy.join(', ')}`);
  const definition = parseGraphDefinition(proposal.definition);
  if (proposal.decisions !== undefined && (!Array.isArray(proposal.decisions) || proposal.decisions.length > 50
    || proposal.decisions.some(item => typeof item !== 'string' || !item.trim() || item.length > 800))) invalid('Decisions must be a bounded list of nonempty strings');
  if (!Array.isArray(proposal.acceptance) || !proposal.acceptance.length) invalid('At least one acceptance check is required');
  if (new Set(proposal.acceptance.map(item => item.id)).size !== proposal.acceptance.length) invalid('Acceptance IDs must be unique');
  if (definition.acceptance?.length !== proposal.acceptance.length) invalid('Draft acceptance must match every criterion in the graph definition');
  for (const item of proposal.acceptance) {
    const known = Object.hasOwn(definition.nodes, item.checkNode) || Object.hasOwn(definition.modules, item.checkNode);
    if (!text(item.id) || !text(item.description) || !known) invalid('Each acceptance item must name a node or module in the graph definition');
    const criterion = definition.acceptance!.find(required => required.id === item.id);
    if (!criterion || criterion.description !== item.description
      || criterion.kind === 'check' && criterion.module !== item.checkNode
      || criterion.kind === 'review' && criterion.node !== item.checkNode) {
      invalid('Draft acceptance IDs, descriptions and check targets must match the graph definition');
    }
  }
}
