import type { Operation } from '../core/types.ts';

/** Task briefing package: goal, acceptance, decisions, and dependency artifact locations. */
export function briefing(operation: Operation, extra: { request: string; summary?: string; acceptance: { id: string; description: string }[] }) {
  const artifacts = Object.values(operation.dependencySources).flatMap(sources => sources.flatMap(source => source.artifacts.map(artifact => `${artifact.path} (${artifact.digest})`)));
  return [
    `Request: ${extra.request}`,
    extra.summary ? `Summary: ${extra.summary}` : '',
    extra.acceptance.length ? `Acceptance:\n${extra.acceptance.map(item => `- ${item.id}: ${item.description}`).join('\n')}` : '',
    artifacts.length ? `Artifacts:\n${artifacts.map(item => `- ${item}`).join('\n')}` : '',
    operation.context.answers.length ? `Answers: ${JSON.stringify(operation.context.answers)}` : '',
  ].filter(Boolean).join('\n');
}
