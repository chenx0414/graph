import type { Json, NodeSpec, Operation } from '../core/types.ts';
import { isImageAttachment } from '../core/attachments.ts';

/** Task briefing package: goal, acceptance, decisions, and dependency artifact locations. */
export function briefing(operation: Omit<Operation, 'id' | 'generation' | 'attempt'>, extra: { request: string; summary?: string; acceptance: { id: string; description: string; checkNode: string }[]; capabilities?: { id: string; version: string }[]; catalog?: { definitions?: string[]; capabilities?: string[]; agentCombinations?: { id: string; name: string; description: string; recommendedGrade: string; status: string }[] }; graph?: NodeSpec[]; focus?: string; review?: { kind: string }[]; conversation?: string; decisions?: string; systemContext?: { resources?: boolean; agentCombinations?: boolean; systemSummary?: boolean } }) {
  const artifacts = Object.values(operation.dependencySources).flatMap(sources => sources.flatMap(source => source.artifacts.map(artifact =>
    `${artifact.uri ?? artifact.path} (${artifact.digest})`)));
  const catalogDefinitions = extra.catalog?.definitions ?? [];
  const catalogCapabilities = extra.catalog?.capabilities ?? [];
  const catalogAgentCombinations = extra.catalog?.agentCombinations ?? [];
  const attachments = (operation.context.messages ?? []).flatMap(message =>
    (message.attachments ?? []).map(attachment => isImageAttachment(attachment)
      // Image bytes reach the model through prompt(text, { images }); the
      // briefing only names the file so it never carries base64.
      ? `- ${attachment.name} (${attachment.size} bytes, ${attachment.type}); delivered as an image attachment`
      : [
          `- ${attachment.name} (${attachment.size} bytes, ${attachment.type || 'text/plain'})`,
          '```text',
          attachment.text,
          '```',
        ].join('\n')));
  // A graph node's own briefing carries only what that node acts on. The requirement version and the
  // message anchors belong to the master, the only role that proposes graphs and cites messages.
  const own = extra.focus;
  return [
    `Request: ${extra.request}`,
    own === undefined ? `Requirement version: ${operation.requirementVersion}` : '',
    operation.context.messages?.length
      ? `User messages:\n${operation.context.messages.map(message => own === undefined
          ? `- ${message.id ? `[${message.id}] ` : ''}(v${message.requirementVersion}) ${message.text}`
          : `- ${message.text}`).join('\n')}`
      : '',
    attachments.length ? `Attachments supplied by the user:\n${attachments.join('\n')}` : '',
    extra.conversation ? `Conversation and execution status:\n${extra.conversation}` : '',
    extra.decisions ? `Decisions and constraints from the conversation:\n${extra.decisions}` : '',
    // A summary that only repeats the request is noise, and in practice the master copies the request
    // into the proposal summary; a summary that says something else is worth keeping for either role.
    extra.summary && (own === undefined || extra.summary !== extra.request) ? `Summary: ${extra.summary}` : '',
    extra.acceptance.length ? `Acceptance:\n${extra.acceptance.map(item => `- ${item.id} (check ${item.checkNode}): ${item.description}`).join('\n')}` : '',
    extra.capabilities?.length ? `Bound capabilities:\n${extra.capabilities.map(item => `- ${item.id}@${item.version}`).join('\n')}` : '',
    catalogDefinitions.length || catalogCapabilities.length || catalogAgentCombinations.length
      ? `Catalog:\n${[
          ...catalogDefinitions.map(item => `- definition ${item}`),
          ...catalogCapabilities.map(item => `- capability ${item}`),
          ...catalogAgentCombinations.map(item => `- Agent recipe ${item.id} (${item.name}, ${item.recommendedGrade}, ${item.status}): ${item.description}`),
        ].join('\n')}`
      : '',
    extra.systemContext && (extra.systemContext.resources || extra.systemContext.agentCombinations || extra.systemContext.systemSummary)
      ? [
          'System context (read-only; query before planning instead of guessing):',
          extra.systemContext.resources ? '- search_resources / get_resource: the user capability directory of Skills, MCP servers, Pi extensions, Graph extensions and prompt identities. get_resource accepts id or id@version. Search is discovery only; definition-bound capabilities are available under the default capability-bypass runtime policy.' : '',
          extra.systemContext.agentCombinations ? '- list_agent_combinations / get_agent_combination: recipe descriptions summarize intended use and should guide subagent selection; use get_agent_combination with the recipe id (for example coder), not get_resource with a definition version (for example coder@5). Creating, editing or deleting a recipe goes through the console HTTP routes documented in docs/agent/agent-recipes.md.' : '',
          extra.systemContext.systemSummary ? '- read_system_capabilities: configured subscription plans, configured models, Agent definitions, graph architectures and quota windows (secrets excluded).' : '',
        ].filter(Boolean).join('\n')
      : '',
    extra.graph?.length
      ? own === undefined
        ? `Task graph (program checks run these inputs; confirmed check inputs must stay unchanged):\n${extra.graph.map(nodeLine).join('\n')}`
        : focusBriefing(own, extra.graph)
      : '',
    extra.review?.some(item => item.kind === 'independent')
      ? [
          'Your result feeds a graph.verify independent gate. Submit it with submit_result; outputJson must be:',
          '{"schemaVersion":1,"body":{"kind":"independent","verdict":"pass|fail|unresolved","reason":"<nonempty>","evidence":[{"path":"<absolute path of your written review file>","digest":"<sha256 hex of that file>"}]}}',
          'Write the review to a file first and compute its sha256 with a small node command run through bash; do not fabricate the digest.',
        ].join('\n')
      : extra.review?.length
        ? `Your result feeds a graph.verify ${extra.review[0]!.kind} gate; submit the report schema that gate expects, including exact artifact versions from the dependency inputs.`
        : '',
    artifacts.length ? `Artifacts:\n${artifacts.map(item => `- ${item}`).join('\n')}` : '',
    operation.context.answers.length ? `Answers: ${JSON.stringify(operation.context.answers)}` : '',
  ].filter(Boolean).join('\n');
}

/** The whole graph, one line per node: what the master reads when it revises the graph. */
function nodeLine(node: NodeSpec) {
  return `- ${nodeHeader(node)}${node.input === undefined ? '' : ` input=${JSON.stringify(node.input)}`}`;
}

/** The same header without the input: a node's own view prints its input as readable lines instead. */
function nodeHeader(node: NodeSpec) {
  return `${node.id} (${node.kind} ${node.action})${node.dependsOn?.length ? ` after ${node.dependsOn.join(', ')}` : ''}`;
}

const CHECK_ACTIONS = ['graph.command', 'graph.verify', 'graph.human_check'];

/** What a gate prints for one check: the command it runs, never the JSON that describes it. */
function checkLine(node: NodeSpec) {
  const input = node.input as { command?: unknown; args?: unknown } | undefined;
  const args = Array.isArray(input?.args) ? input.args.filter((arg): arg is string => typeof arg === 'string') : [];
  if (typeof input?.command === 'string') return `${node.id}: ${[input.command, ...args].join(' ')}`;
  if (node.action === 'graph.verify') {
    const verifier = (node as { verifier?: { kind?: string; reportNodes?: string[] } }).verifier;
    return `${node.id}: ${verifier?.kind ?? 'independent'} review of ${(verifier?.reportNodes ?? []).join(', ') || '(no report node)'}`;
  }
  return `${node.id}: the user's own check`;
}

/** One node's input as readable lines: a file list belongs on one line, free text on its own. */
function inputLines(input: Json | undefined): string[] {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return [`  input: ${JSON.stringify(input)}`];
  return Object.entries(input).map(([key, value]) => `  ${key}: ${Array.isArray(value) ? value.join(', ') : typeof value === 'string' ? value : JSON.stringify(value)}`);
}

/**
 * One node's view of the graph: its own node, the checks that read its output, and sibling lanes by id
 * only. The full listing is 56-71% of a node briefing and the bulk of it is sibling file lists - files
 * this node must not touch anyway (`rules/worker.md`) and which the integration gate restores.
 */
function focusBriefing(own: string, graph: readonly NodeSpec[]) {
  const byId = new Map(graph.map(node => [node.id, node]));
  const reads = (node: NodeSpec) => {
    const seen = new Set<string>();
    const walk = (id: string): boolean => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (id === own) return true;
      return (byId.get(id)?.dependsOn ?? []).some(walk);
    };
    return (node.dependsOn ?? []).some(walk);
  };
  const mine = byId.get(own);
  const checks = graph.filter(node => CHECK_ACTIONS.includes(node.action) && reads(node));
  const others = graph.filter(node => node.id !== own && !checks.includes(node));
  return [
    'Task graph (program checks run these inputs; confirmed check inputs must stay unchanged):',
    mine ? `Your node: ${nodeHeader(mine)}` : `Your node: ${own}`,
    ...(mine ? inputLines(mine.input) : []),
    ...(checks.length ? ['Checks that read your output:', ...checks.map(node => `- ${checkLine(node)}`)] : []),
    ...(others.length ? [`Other lanes (ids only): ${others.map(node => node.id).join(', ')}`] : []),
  ].join('\n');
}
