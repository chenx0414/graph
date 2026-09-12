import type { Proposal } from '../../src/core/types.ts';

/** Frozen MediaBookmarks Bilibili web acceptance discussed inside Graph. */
export function mediaBookmarksProposal(requirementVersion: number): Proposal {
  return {
    requirementVersion,
    summary: '本机 Web 复用 CLI：B站登录态、采集进度与失败原因、收藏与笔记、Markdown 导出。采集使用项目内 .browser-profile，禁止并发采集，不共享日常 Chrome。登录由使用者在 CLI 完成后再确认人工检查项。',
    acceptance: [
      { id: 'login-status', description: '页面展示 B站登录态，并标明独立 profile 与不可并发采集', checkNode: 'check' },
      { id: 'collect-progress', description: '可发起采集并看到进度与失败原因', checkNode: 'check' },
      { id: 'browse-notes', description: '可浏览收藏条目与已有 Markdown 笔记', checkNode: 'check' },
      { id: 'export-md', description: '可导出 Markdown 并得到非空结果', checkNode: 'check' },
      { id: 'human-login', description: '使用者在独立 profile 完成 B站登录后确认', checkNode: 'login' },
    ],
    nodes: [
      { id: 'master', kind: 'agent', action: 'master', role: 'master', definitionVersion: 'master@1', model: 'scripted' },
      { id: 'web-api', kind: 'agent', action: 'web-api', role: 'worker', definitionVersion: 'coder@1', model: 'scripted', dependsOn: ['master'] },
      { id: 'web-ui', kind: 'agent', action: 'web-ui', role: 'worker', definitionVersion: 'coder@1', model: 'scripted', dependsOn: ['master'] },
      { id: 'web-test', kind: 'agent', action: 'web-test', role: 'worker', definitionVersion: 'coder@1', model: 'scripted', dependsOn: ['web-api', 'web-ui'] },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['web-test'] },
      { id: 'review', kind: 'agent', action: 'review', role: 'worker', definitionVersion: 'reviewer@1', model: 'scripted', dependsOn: ['check'] },
      { id: 'review-gate', kind: 'program', action: 'graph.verify', dependsOn: ['review'], verifier: { kind: 'independent', reportNodes: ['review'] } },
      { id: 'login', kind: 'program', action: 'graph.human_check', dependsOn: ['review-gate'] },
    ],
  };
}
