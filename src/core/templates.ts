import type { ContainerSpec, LoopSpec, NodeSpec, Proposal } from './types.ts';
import type { VerifierConfig } from './verification.ts';

const coder = { definitionVersion: 'coder@1', model: 'scripted' };
type Graph = Pick<Proposal, 'nodes' | 'containers' | 'loops'>;
const agent = (id: string, action: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({ id, kind: 'agent', action, ...coder, ...extra });
const program = (id: string, action: string, extra: Partial<NodeSpec> = {}): NodeSpec => ({ id, kind: 'program', action, ...extra });

/** Reusable graph shapes expand to ordinary nodes, containers and loops. */
export function pipeline(ids = { implement: 'implement', check: 'check' }): Graph {
  return { nodes: [agent(ids.implement, 'implement'), program(ids.check, 'check', { dependsOn: [ids.implement] })] };
}

export function fanout(ids = { left: 'left', right: 'right', check: 'check' }): Graph {
  return { nodes: [agent(ids.left, 'left'), agent(ids.right, 'right'), program(ids.check, 'check', { dependsOn: [ids.left, ids.right] })] };
}

export function router(ids = { route: 'route', text: 'text', json: 'json', join: 'join', check: 'check' }): Graph {
  return {
    containers: [{ id: 'outer', outputs: [ids.join] }, { id: 'inner', parent: 'outer', outputs: [ids.text, ids.json] }] satisfies ContainerSpec[],
    nodes: [
      program(ids.route, 'route', { container: 'outer', routes: ['text', 'json'] }),
      agent(ids.text, 'text', { container: 'inner', when: { node: ids.route, case: 'text' } }),
      agent(ids.json, 'json', { container: 'inner', when: { node: ids.route, case: 'json' } }),
      program(ids.join, 'join', { container: 'outer', dependsOn: ['inner'] }),
      program(ids.check, 'check', { dependsOn: ['outer'] }),
    ],
  };
}

export function supervisorWorkers(count = 2, ids = { master: 'master', check: 'check' }): Graph {
  const workers = Array.from({ length: count }, (_, index) => agent(`worker-${index}`, 'worker', { role: 'worker', dependsOn: [ids.master] }));
  return { nodes: [agent(ids.master, 'master', { role: 'master' }), ...workers, program(ids.check, 'check', { dependsOn: [ids.master, ...workers.map(node => node.id)] })] };
}

export function evaluateOptimize(config: VerifierConfig, ids = { implement: 'implement', review: 'review', gate: 'gate' }): Graph {
  return {
    loops: [{ from: ids.gate, to: ids.implement }] satisfies LoopSpec[],
    nodes: [
      agent(ids.implement, 'implement'),
      agent(ids.review, 'review', { dependsOn: [ids.implement] }),
      program(ids.gate, 'graph.verify', { dependsOn: [ids.implement, ids.review], verifier: config }),
    ],
  };
}

export function adversarial(config: Extract<VerifierConfig, { kind: 'adversarial' }>, ids = { implement: 'implement', critic: 'critic', gate: 'gate' }): Graph {
  return {
    loops: [{ from: ids.gate, to: ids.implement }],
    nodes: [
      agent(ids.implement, 'implement'),
      agent(ids.critic, 'critic', { dependsOn: [ids.implement] }),
      program(ids.gate, 'graph.verify', { dependsOn: [ids.implement, ids.critic], verifier: config }),
    ],
  };
}

export function multiview(config: Extract<VerifierConfig, { kind: 'multiview' }>, ids = { implement: 'implement', review: 'review', gate: 'gate' }): Graph {
  return {
    nodes: [
      agent(ids.implement, 'implement'),
      agent(ids.review, 'review', { dependsOn: [ids.implement] }),
      program(ids.gate, 'graph.verify', { dependsOn: [ids.implement, ids.review], verifier: config }),
    ],
  };
}

export function jury(config: { select: Extract<VerifierConfig, { kind: 'jury' }>; final: Extract<VerifierConfig, { kind: 'jury' }> }, ids = { a: 'candidate-a', b: 'candidate-b', jury: 'jury', select: 'select', absorb: 'absorb', review: 'final-review', final: 'final' }): Graph {
  return {
    loops: [{ from: ids.select, to: ids.a }, { from: ids.select, to: ids.b }, { from: ids.final, to: ids.absorb }],
    nodes: [
      agent(ids.a, 'candidate'),
      agent(ids.b, 'candidate'),
      agent(ids.jury, 'jury', { dependsOn: [ids.a, ids.b] }),
      program(ids.select, 'graph.verify', { dependsOn: [ids.a, ids.b, ids.jury], verifier: config.select }),
      agent(ids.absorb, 'absorb', {
        dependsOn: [ids.select, ids.a, ids.b],
        context: { predecessors: [
          { source: ids.a, mode: 'evidence_only' },
          { source: ids.b, mode: 'evidence_only' },
        ] },
      }),
      agent(ids.review, 'final-review', { dependsOn: [ids.absorb] }),
      program(ids.final, 'graph.verify', { dependsOn: [ids.select, ids.absorb, ids.review], verifier: config.final }),
    ],
  };
}
