import type {
  EdgeDefinition, GraphDefinition, GraphIo, GraphOutput, ModuleDefinition, NodeDefinition,
} from './interface-spec.ts';

/**
 * Subgraph expansion (Issue #1 §2, §9).
 *
 * A subgraph is a template whose PUBLIC io is mapped into the parent's connection
 * model. Expansion is a pure rewrite of a definition fragment — it produces no
 * extra execution and no synthetic scheduler step: the subgraph's nodes and modules
 * simply appear in the parent with stable, instance-prefixed paths (`build/work`),
 * so a subgraph instance is addressable and its state is isolated from any sibling
 * instance of the same template.
 *
 * The template's exact version is pinned in the returned fragment, so a later edit
 * to the template can never hot-change an instance that was already expanded.
 */

export interface ExpandInput {
  /** The subgraph instance name; every internal id is prefixed with it. */
  instance: string;
  template: GraphDefinition;
  /** The template revision this instance pins; recorded for provenance. */
  templateVersion: number;
  /** Parent-side endpoints that feed the subgraph's public inputs. */
  inputWiring?: Record<string, string>;
  /** Parent-side endpoints the subgraph's public outputs feed. */
  outputWiring?: Record<string, string>;
}

export interface ExpandedSubgraph {
  instance: string;
  templateVersion: number;
  nodes: Record<string, NodeDefinition>;
  modules: Record<string, ModuleDefinition>;
  edges: Record<string, EdgeDefinition>;
  /** The subgraph's public input map, re-pointed at prefixed endpoints. */
  inputs: Record<string, GraphIo>;
  /** The subgraph's public output map, re-pointed at prefixed endpoints. */
  outputs: Record<string, GraphOutput>;
  /** Parent-side endpoints this subgraph's public io connects to (from inputWiring/outputWiring). */
  wiring: { inputs: Record<string, string>; outputs: Record<string, string> };
}

const endpoint = (instance: string, reference: string): string => {
  const dot = reference.indexOf('.');
  if (dot <= 0) return reference;
  return `${instance}/${reference.slice(0, dot)}${reference.slice(dot)}`;
};

export function expandSubgraph(input: ExpandInput): ExpandedSubgraph {
  const { instance, template, templateVersion } = input;
  if (!instance.trim()) throw new Error('A subgraph instance requires a name');

  const nodes: Record<string, NodeDefinition> = {};
  for (const [id, node] of Object.entries(template.nodes)) nodes[`${instance}/${id}`] = node;
  const modules: Record<string, ModuleDefinition> = {};
  for (const [id, module] of Object.entries(template.modules)) modules[`${instance}/${id}`] = module;

  // Internal edges are re-pointed, never duplicated: expansion adds no connection
  // the template did not declare.
  const edges: Record<string, EdgeDefinition> = {};
  for (const [id, edge] of Object.entries(template.edges)) {
    edges[id] = { ...edge, from: endpoint(instance, edge.from), to: endpoint(instance, edge.to) };
  }

  const inputs: Record<string, GraphIo> = {};
  for (const [name, io] of Object.entries(template.inputs)) {
    inputs[name] = { ...io, to: endpoint(instance, io.to) };
  }
  const outputs: Record<string, GraphOutput> = {};
  for (const [name, io] of Object.entries(template.outputs)) {
    outputs[name] = { ...io, from: endpoint(instance, io.from) };
  }

  return {
    instance,
    templateVersion,
    nodes,
    modules,
    edges,
    inputs,
    outputs,
    wiring: { inputs: { ...(input.inputWiring ?? {}) }, outputs: { ...(input.outputWiring ?? {}) } },
  };
}

/** A marker recording that a parent definition contains expanded subgraph instances. */
export const SUBGRAPH_MARKER = 'subgraphs';
