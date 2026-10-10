import { join } from 'node:path';
import { graphApplicationRoot } from './graph-root.ts';

export interface GraphDocumentationPaths {
  /** Source directory containing the read-only Agent-facing documentation. */
  root: string;
  /** Main Graph documentation entrypoint. */
  main: string;
  /** Source examples referenced by the documentation reading protocol. */
  examples: string;
}

/** Resolve Graph's Agent documentation from the running source checkout or
 * packaged app resources. Docs are product source, not user prompt data. */
export function graphDocumentationPaths(appRoot = graphApplicationRoot()): GraphDocumentationPaths {
  const root = join(appRoot, 'docs', 'agent');
  return {
    root,
    main: join(root, 'README.md'),
    examples: join(appRoot, 'examples'),
  };
}

export function graphDocumentationPrompt(paths: GraphDocumentationPaths) {
  return [
    'Graph documentation (read when the user asks about Graph itself, its Agent runtime, tools, task execution, recovery, permissions or configuration, and whenever you change Graph\'s own code, prompts or harness):',
    `- Main documentation: ${paths.main}`,
    `- Running Graph API: schemaVersion:2, interface deliveries. To build, validate, start or patch a graph, read ${join(paths.root, 'graph-v2.md')} first; complete native examples: ${join(paths.root, '..', 'design-graph-examples.md')}`,
    `- Additional docs: ${paths.root}`,
    `- Examples: ${paths.examples} (runtime demos and acceptance fixtures)`,
    '- These absolute paths belong to the running application. A business checkout may contain an older Graph version: its docs and source describe the task target, not this host API. Do not infer runtime tool arguments from that checkout or old conversation memory.',
    '- When reading Graph docs or examples, resolve topic paths under Additional docs and `examples/...` under Examples, not the current working directory',
    '- When asked about: task orchestration (`graph-overview.md`), execution and recovery (`execution-model.md`, `permissions-and-recovery.md`), tools and capabilities (`capabilities.md`), Git and artifacts (`artifacts-and-git.md`), prompt and tool configuration (`self-configuration.md`), model, provider and subscription configuration (`models-and-providers.md`), Agent recipe authoring (`agent-recipes.md`), troubleshooting (`troubleshooting.md`)',
    '- Read the complete relevant topic. Follow only references needed for the current operation; implementation reports, historical ADRs and the full spec are for deeper investigation, not a prerequisite to building a graph.',
  ].join('\n');
}
