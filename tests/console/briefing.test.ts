import { expect, test } from 'vitest';
import { briefing } from '../../src/catalog/briefing.ts';
import type { Operation } from '../../src/core/types.ts';

test('text attachments are included in the master briefing without changing the user message', () => {
  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1,
    context: {
      previousOutput: null,
      answers: [],
      messages: [{
        id: 'message', text: '请查看附件', requirementVersion: 1,
        attachments: [{ name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' }],
      }],
    },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, { request: 'request', acceptance: [] });
  expect(text).toContain('User messages:\n- [message] (v1) 请查看附件');
  expect(text).toContain('Attachments supplied by the user');
  expect(text).toContain('notes.md (8 bytes, text/markdown)');
  expect(text).toContain('# Notes');
});

test('Agent recipe descriptions are included in the master catalog for subagent selection', () => {
  const operation: Operation = {
    id: 'operation', taskId: 'task', nodeId: 'master', instanceId: 'instance', generation: 1,
    attempt: 1, kind: 'agent', action: 'master', input: null, dependencies: {}, proposalVersion: 0,
    requirementVersion: 1, context: { previousOutput: null, answers: [] },
    grants: [], activationId: 'activation', graphVersion: 0, dependencySources: {}, inputVersions: {},
  };
  const text = briefing(operation, {
    request: 'request',
    acceptance: [],
    catalog: {
      definitions: ['coder@1'],
      agentCombinations: [{
        id: 'coder',
        name: 'Bob_coder',
        description: '默认主实现，承担功能开发、维护、修复和基础测试。',
        recommendedGrade: 'medium',
        status: 'valid',
      }],
    },
  });
  expect(text).toContain('- Agent recipe coder (Bob_coder, medium, valid): 默认主实现，承担功能开发、维护、修复和基础测试。');
});
