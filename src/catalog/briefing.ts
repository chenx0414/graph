import type { NodeSpec, Operation } from '../core/types.ts';

/** Task briefing package: goal, acceptance, decisions, and dependency artifact locations. */
export function briefing(operation: Omit<Operation, 'id' | 'generation' | 'attempt'>, extra: { request: string; summary?: string; acceptance: { id: string; description: string; checkNode: string }[]; capabilities?: { id: string; version: string }[]; catalog?: { definitions?: string[]; capabilities?: string[] }; graph?: NodeSpec[]; review?: { kind: string }[]; conversation?: string; decisions?: string; systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean; requestModelAccess?: boolean } }) {
  const artifacts = Object.values(operation.dependencySources).flatMap(sources => sources.flatMap(source => source.artifacts.map(artifact =>
    `${artifact.uri ?? artifact.path} (${artifact.digest})`)));
  const catalogDefinitions = extra.catalog?.definitions ?? [];
  const catalogCapabilities = extra.catalog?.capabilities ?? [];
  const attachments = (operation.context.messages ?? []).flatMap(message =>
    (message.attachments ?? []).map(attachment => [
      `- ${attachment.name} (${attachment.size} bytes, ${attachment.type || 'text/plain'})`,
      '```text',
      attachment.text,
      '```',
    ].join('\n')));
  return [
    `Request: ${extra.request}`,
    `Requirement version: ${operation.requirementVersion}`,
    operation.context.messages?.length
      ? `User messages:\n${operation.context.messages.map(message => `- ${message.id ? `[${message.id}] ` : ''}(v${message.requirementVersion}) ${message.text}`).join('\n')}`
      : '',
    attachments.length ? `Attachments supplied by the user:\n${attachments.join('\n')}` : '',
    extra.conversation ? `Conversation and execution status:\n${extra.conversation}` : '',
    extra.decisions ? `Decisions and constraints from the conversation:\n${extra.decisions}` : '',
    extra.summary ? `Summary: ${extra.summary}` : '',
    extra.acceptance.length ? `Acceptance:\n${extra.acceptance.map(item => `- ${item.id} (check ${item.checkNode}): ${item.description}`).join('\n')}` : '',
    extra.capabilities?.length ? `Bound capabilities:\n${extra.capabilities.map(item => `- ${item.id}@${item.version}`).join('\n')}` : '',
    catalogDefinitions.length || catalogCapabilities.length
      ? `Catalog:\n${[...catalogDefinitions.map(item => `- definition ${item}`), ...catalogCapabilities.map(item => `- capability ${item}`)].join('\n')}`
      : '',
    extra.systemContext && (extra.systemContext.resources || extra.systemContext.agentCombinations || extra.systemContext.systemSummary || extra.systemContext.requestModelAccess)
      ? [
          'System context (read-only; query before planning instead of guessing):',
          extra.systemContext.resources ? '- search_resources / get_resource: the user capability directory of Skills, MCP servers, Pi extensions, Graph extensions and prompt identities. get_resource accepts id or id@version. Search is discovery only; definition-bound capabilities are available under the default capability-bypass runtime policy.' : '',
          extra.systemContext.agentCombinations ? '- list_agent_combinations / get_agent_combination / save_agent_combination / compile_agent_combination: recipes reference existing capabilities and compile directly to a dispatchable definition. Use get_agent_combination with the recipe id (for example coder), not get_resource with a definition version (for example coder@5).' : '',
          extra.systemContext.systemSummary ? '- read_system_capabilities: configured subscription plans, configured models, Agent definitions, graph architectures and quota windows (secrets excluded).' : '',
          extra.systemContext.requestModelAccess ? '- request_model_access: ask the user to configure a needed model or subscription; it never changes configuration or grants permission itself.' : '',
        ].filter(Boolean).join('\n')
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
