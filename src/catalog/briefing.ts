import type { NodeSpec, Operation } from '../core/types.ts';

/** Task briefing package: goal, acceptance, decisions, and dependency artifact locations. */
export function briefing(operation: Operation, extra: { request: string; summary?: string; acceptance: { id: string; description: string; checkNode: string }[]; capabilities?: { id: string; version: string }[]; catalog?: { definitions: string[]; capabilities: string[] }; graph?: NodeSpec[]; review?: { kind: string }[] }) {
  const artifacts = Object.values(operation.dependencySources).flatMap(sources => sources.flatMap(source => source.artifacts.map(artifact => `${artifact.path} (${artifact.digest})`)));
  return [
    `Request: ${extra.request}`,
    `Requirement version: ${operation.requirementVersion}`,
    operation.context.messages?.length
      ? `User messages:\n${operation.context.messages.map(message => `- (v${message.requirementVersion}) ${message.text}`).join('\n')}`
      : '',
    extra.summary ? `Summary: ${extra.summary}` : '',
    extra.acceptance.length ? `Acceptance:\n${extra.acceptance.map(item => `- ${item.id} (check ${item.checkNode}): ${item.description}`).join('\n')}` : '',
    extra.capabilities?.length ? `Bound capabilities:\n${extra.capabilities.map(item => `- ${item.id}@${item.version}`).join('\n')}` : '',
    extra.catalog && (extra.catalog.definitions.length || extra.catalog.capabilities.length)
      ? `Catalog:\n${[...extra.catalog.definitions.map(item => `- definition ${item}`), ...extra.catalog.capabilities.map(item => `- capability ${item}`)].join('\n')}`
      : '',
    extra.graph?.length
      ? `Task graph (program checks run these inputs; confirmed check inputs must stay unchanged):\n${extra.graph.map(node => `- ${node.id} (${node.kind} ${node.action})${node.dependsOn?.length ? ` after ${node.dependsOn.join(', ')}` : ''}${node.input === undefined ? '' : ` input=${JSON.stringify(node.input)}`}`).join('\n')}`
      : '',
    extra.review?.some(item => item.kind === 'independent')
      ? [
          'Your result feeds a graph.verify independent gate. Submit it with submit_result; outputJson must be:',
          '{"schemaVersion":1,"body":{"kind":"independent","verdict":"pass|fail|unresolved","reason":"<nonempty>","evidence":[{"path":"<absolute path of your written review file>","digest":"<sha256 hex of that file>"}]}}',
          'Write the review to a file first and compute its sha256 with a small node script run through run_command; do not fabricate the digest.',
        ].join('\n')
      : extra.review?.length
        ? `Your result feeds a graph.verify ${extra.review[0]!.kind} gate; submit the report schema that gate expects, including exact artifact versions from the dependency inputs.`
        : '',
    artifacts.length ? `Artifacts:\n${artifacts.map(item => `- ${item}`).join('\n')}` : '',
    operation.context.answers.length ? `Answers: ${JSON.stringify(operation.context.answers)}` : '',
  ].filter(Boolean).join('\n');
}
