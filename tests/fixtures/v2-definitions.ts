import { parseGraphDefinition, type GraphDefinition } from '../../src/core/interface-spec.ts';

/**
 * Issue #1 §13.1 / §16: three executable definitions the new kernel must accept —
 * a plain pipeline, a rework loop, and a two-reviewer fan-in. They are real graph
 * definitions, not documentation: every spike and later phase parses these exact
 * objects, so a regression in the interface breaks the fixtures that stand on it.
 *
 * The implementation-request protocol is declared in full here (§4: the example in
 * the spec is not a runnable fixture).
 */

const implementationRequest = {
  type: 'object',
  required: ['goal', 'repository'],
  properties: {
    goal: { type: 'string' },
    repository: { type: 'string' },
    base: { type: 'string' },
  },
};

const codeResult = {
  type: 'object',
  required: ['repository', 'commit', 'artifact'],
  properties: {
    repository: { type: 'string' },
    commit: { type: 'string' },
    artifact: { type: 'object' },
  },
};

const reviewResult = {
  type: 'object',
  required: ['passed', 'reason', 'reviewedCommit'],
  properties: {
    passed: { type: 'boolean' },
    reason: { type: 'string' },
    reviewedCommit: { type: 'string' },
  },
};

export const pipelineDefinition: GraphDefinition = parseGraphDefinition({
  schemaVersion: 2,
  name: 'implement-only',
  protocols: { 'implementation-request': implementationRequest, 'code-result': codeResult },
  nodes: {
    worker: {
      recipe: 'worker@1',
      task: '按需求实现功能',
      acceptance: ['满足确认需求'],
      inputs: { task: { protocol: 'implementation-request' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
  },
  modules: {},
  edges: {},
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { result: { from: 'worker.result', protocol: 'code-result' } },
  completion: { on: 'result', drain: true },
});

export const reworkDefinition: GraphDefinition = parseGraphDefinition({
  schemaVersion: 2,
  name: 'implement-and-review',
  protocols: {
    'implementation-request': implementationRequest,
    'code-result': codeResult,
    'review-result': reviewResult,
  },
  nodes: {
    worker: {
      recipe: 'worker@1',
      task: '实现功能并根据审查意见返工',
      acceptance: ['满足确认需求', '完成约定检查'],
      inputs: { task: { protocol: 'implementation-request' }, rework: { protocol: 'review-result' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
    reviewer: {
      recipe: 'work-reviewer@1',
      task: '审查收到的具体 commit',
      acceptance: ['结论附理由与审查版本'],
      inputs: { code: { protocol: 'code-result' } },
      outputs: { review: { protocol: 'review-result' } },
      submission: { required: ['review'] },
    },
  },
  modules: {
    'review-route': {
      type: 'router',
      trigger: 'each',
      inputs: { review: { protocol: 'review-result' } },
      outputs: { rework: { protocol: 'review-result' }, approved: { protocol: 'review-result' } },
      rules: [
        { when: 'review.passed == false', emit: { rework: '$review' } },
        { when: 'review.passed == true', emit: { approved: '$review' } },
      ],
    },
  },
  edges: {
    'worker-review': { from: 'worker.result', to: 'reviewer.code', enabled: true },
    'review-route': { from: 'reviewer.review', to: 'review-route.review', enabled: true },
    rework: { from: 'review-route.rework', to: 'worker.rework', enabled: true },
  },
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { result: { from: 'review-route.approved', protocol: 'review-result' } },
  completion: { on: 'result', drain: true },
});

/**
 * Two independent reviewers feed one fan-in point. Fan-in is a module's job (§2),
 * so both review outputs map into one named module input; the module waits for a
 * complete set and emits once. Each reviewer has its own named input on the
 * final module, which is how the kernel keeps "waiting" distinct from "received false".
 */
export const dualReviewDefinition: GraphDefinition = parseGraphDefinition({
  schemaVersion: 2,
  name: 'dual-review-fan-in',
  protocols: {
    'implementation-request': implementationRequest,
    'code-result': codeResult,
    'review-result': reviewResult,
    'review-pair': {
      type: 'object',
      required: ['first', 'second'],
      properties: { first: reviewResult, second: reviewResult },
    },
  },
  nodes: {
    worker: {
      recipe: 'worker@1',
      task: '实现功能',
      inputs: { task: { protocol: 'implementation-request' } },
      outputs: { result: { protocol: 'code-result' } },
      submission: { required: ['result'] },
    },
    'reviewer-a': {
      recipe: 'work-reviewer@1',
      task: '独立审查（视角 A）',
      inputs: { code: { protocol: 'code-result' } },
      outputs: { review: { protocol: 'review-result' } },
      submission: { required: ['review'] },
    },
    'reviewer-b': {
      recipe: 'work-reviewer@1',
      task: '独立审查（视角 B）',
      inputs: { code: { protocol: 'code-result' } },
      outputs: { review: { protocol: 'review-result' } },
      submission: { required: ['review'] },
    },
  },
  modules: {
    'fan-in': {
      type: 'router',
      trigger: 'once',
      requiredInputs: ['a', 'b'],
      inputs: { a: { protocol: 'review-result' }, b: { protocol: 'review-result' } },
      outputs: { pair: { protocol: 'review-pair' } },
      rules: [
        { when: '$exists(a) && $exists(b)', emit: { pair: { first: '$a', second: '$b' } } },
      ],
    },
  },
  edges: {
    'worker-a': { from: 'worker.result', to: 'reviewer-a.code', enabled: true },
    'worker-b': { from: 'worker.result', to: 'reviewer-b.code', enabled: true },
    'a-fanin': { from: 'reviewer-a.review', to: 'fan-in.a', enabled: true },
    'b-fanin': { from: 'reviewer-b.review', to: 'fan-in.b', enabled: true },
  },
  inputs: { task: { to: 'worker.task', protocol: 'implementation-request' } },
  outputs: { pair: { from: 'fan-in.pair', protocol: 'review-pair' } },
});

export const executableDefinitions = { pipelineDefinition, reworkDefinition, dualReviewDefinition };
