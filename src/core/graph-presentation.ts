export type GraphNodeVisualKind = 'agent' | 'tool' | 'human' | 'gate' | 'route' | 'join' | 'program';

type GraphNodeLike = {
  id: string;
  kind: string;
  action?: string;
  context?: {
    requiredFacts?: { kind?: string }[];
    independence?: string;
    purpose?: string;
  } | null;
};

export function graphNodeVisualKind(node: GraphNodeLike): GraphNodeVisualKind {
  if (node.action === 'graph.human_check' || /(^|[-_])human($|[-_])/i.test(node.id)) return 'human';
  if (node.kind === 'agent') return 'agent';
  if (node.action === 'graph.verify') return 'gate';
  if (node.action === 'route') return 'route';
  if (node.action === 'join') return 'join';
  if (node.action === 'graph.command') return 'tool';
  return node.kind === 'program' ? 'tool' : 'program';
}

export function graphNodeSuffix(node: GraphNodeLike) {
  if (graphNodeVisualKind(node) === 'human') return 'human check';
  if (node.context?.requiredFacts?.some(fact => fact.kind === 'transcript_range' || fact.kind === 'tool_call')) return '继承快照节点';
  if (node.context?.independence && node.context.independence !== 'none') return '独立上下文节点';
  if (node.context?.purpose === 'review' || node.context?.purpose === 'verify') return '独立上下文节点';
  if (node.kind === 'agent') return 'agent';
  if (node.action === 'graph.verify') return 'gate';
  if (node.action === 'graph.command') return 'tool';
  if (node.action === 'route') return 'route';
  if (node.action === 'join') return 'join';
  return node.kind === 'program' ? 'tool' : node.kind;
}

export function graphNodeLabel(node: GraphNodeLike) {
  const suffix = graphNodeSuffix(node);
  const prefix = node.id.toLowerCase();
  return suffix.toLowerCase() === prefix || suffix.toLowerCase().startsWith(`${prefix} `) ? suffix : `${node.id} ${suffix}`;
}

function textWidth(value: string) {
  return [...value].reduce((sum, character) => sum + (character.charCodeAt(0) > 255 ? 13 : 7), 0);
}

/** ELK needs a concrete box, while the browser renders the same measured width. */
export function graphNodeSize(node: GraphNodeLike) {
  const estimated = textWidth(graphNodeLabel(node)) + 74;
  const width = Math.min(360, Math.max(144, Math.ceil(estimated / 8) * 8));
  return { width, height: estimated > 360 ? 72 : 56 };
}
