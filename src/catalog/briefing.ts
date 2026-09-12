import type { Operation } from '../core/types.ts';

/** Task briefing package: goal, acceptance, decisions, and dependency artifact locations. */
export function briefing(operation: Operation, extra: { request: string; summary?: string; acceptance: { id: string; description: string }[]; capabilities?: { id: string; version: string }[]; catalog?: { definitions: string[]; capabilities: string[] } }) {
  const artifacts = Object.values(operation.dependencySources).flatMap(sources => sources.flatMap(source => source.artifacts.map(artifact => `${artifact.path} (${artifact.digest})`)));
  return [
    `Request: ${extra.request}`,
    operation.context.messages?.length
      ? `User messages:\n${operation.context.messages.map(message => `- (v${message.requirementVersion}) ${message.text}`).join('\n')}`
      : '',
    extra.summary ? `Summary: ${extra.summary}` : '',
    extra.acceptance.length ? `Acceptance:\n${extra.acceptance.map(item => `- ${item.id}: ${item.description}`).join('\n')}` : '',
    extra.capabilities?.length ? `Bound capabilities:\n${extra.capabilities.map(item => `- ${item.id}@${item.version}`).join('\n')}` : '',
    extra.catalog && (extra.catalog.definitions.length || extra.catalog.capabilities.length)
      ? `Catalog:\n${[...extra.catalog.definitions.map(item => `- definition ${item}`), ...extra.catalog.capabilities.map(item => `- capability ${item}`)].join('\n')}`
      : '',
    artifacts.length ? `Artifacts:\n${artifacts.map(item => `- ${item}`).join('\n')}` : '',
    operation.context.answers.length ? `Answers: ${JSON.stringify(operation.context.answers)}` : '',
  ].filter(Boolean).join('\n');
}
