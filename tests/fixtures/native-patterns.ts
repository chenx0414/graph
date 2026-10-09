import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseGraphDefinition, type ModuleDefinition } from '../../src/core/interface-spec.ts';
import type { ReviewPolicy } from '../../src/core/review-policy.ts';

/** Shared formal definitions: execution tests exercise them, HTTP tests inspect their actual geometry. */
export async function nativeReviewPattern(root: string, kind: 'optimize' | 'adversarial' | 'multiview' | 'jury') {
  const jury = kind === 'jury';
  const multi: ReviewPolicy = { kind: 'multiview', subject: 'subject', reports: ['review'], staleReview: 'wait', dimensions: [{ id: 'correctness', required: true, report: 'review' }] };
  const ranked = (candidates: { id: string; subject: string }[]): ReviewPolicy => ({ kind: 'jury', candidates, reports: ['review'], hard: ['builds'], ranking: [{ id: 'quality', weight: 1, min: 0, max: 10 }], tieOrder: ['quality'], staleReview: 'wait' });
  const policy = jury ? ranked([{ id: 'a', subject: 'a' }, { id: 'b', subject: 'b' }]) : kind === 'adversarial' ? { kind: 'adversarial' as const, subject: 'subject', reports: ['review'], criteria: ['works'], staleReview: 'wait' as const } : multi;
  async function generate(id: string, config: ReviewPolicy) {
    const configuration = join(root, `${id}.json`); await writeFile(configuration, JSON.stringify(config));
    const generated = await promisify(execFile)(process.execPath, [join(process.cwd(), 'scripts/create-review-module.ts'), configuration, join(root, `${id}.mjs`)]);
    return JSON.parse(generated.stdout) as ModuleDefinition;
  }
  const data = { protocol: 'data' };
  const nodes = Object.fromEntries((jury ? ['a', 'b', 'review', 'absorb', 'finalreview'] : ['work', 'review']).map(id => [id, { recipe: id.includes('review') ? 'reviewer@1' : 'coder@1', model: id, task: `Execute ${kind} ${id} against the exact published versions`, inputs: { job: data }, outputs: { result: data }, submission: { required: ['result'] } }]));
  const check: ModuleDefinition = { type: 'operation', trigger: 'each', inputs: { job: data }, outputs: { result: data }, operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } };
  const joined = (inputs: string[]): ModuleDefinition => ({ type: 'router', trigger: 'once', requiredInputs: inputs, inputs: Object.fromEntries(inputs.map(id => [id, data])), outputs: { result: data }, rules: [{ when: 'true', emit: { result: Object.fromEntries(inputs.map(id => [id, `$${id}`])) } }] });
  const modules: Record<string, ModuleDefinition> = { gate: await generate('gate', policy), check, ...(jury ? { candidates: joined(['a', 'b']), ready: joined(['a', 'b', 'selection']), final: await generate('final', ranked([{ id: 'absorbed', subject: 'subject' }])) } : {}) };
  const pairs = jury ? [
    ['a.result', 'gate.a'], ['b.result', 'gate.b'], ['a.result', 'candidates.a'], ['b.result', 'candidates.b'], ['candidates.result', 'review.job'], ['review.result', 'gate.review'],
    ['a.result', 'ready.a'], ['b.result', 'ready.b'], ['gate.approved', 'ready.selection'], ['ready.result', 'absorb.job'], ['absorb.result', 'final.subject'], ['absorb.result', 'finalreview.job'], ['finalreview.result', 'final.review'], ['final.approved', 'check.job'],
  ] : [['work.result', 'gate.subject'], ['work.result', 'review.job'], ['review.result', 'gate.review'], ['gate.approved', 'check.job'], ...(kind === 'optimize' || kind === 'adversarial' ? [['gate.rework', 'work.job']] : [])];
  return parseGraphDefinition({ schemaVersion: 2, name: `${kind} native pattern`, protocols: { data: { type: 'object' } }, nodes, modules,
    edges: Object.fromEntries(pairs.map(([from, to], index) => [`edge-${index}`, { from, to, enabled: true }])), outputs: { result: { from: 'check.result', protocol: 'data' } } });
}
