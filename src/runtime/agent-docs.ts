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
    `- Additional docs: ${paths.root}`,
    `- Examples: ${paths.examples} (runtime demos and acceptance fixtures)`,
    '- When reading Graph docs or examples, resolve topic paths under Additional docs and `examples/...` under Examples, not the current working directory',
    '- When asked about: task orchestration (`graph-overview.md`), execution and recovery (`execution-model.md`, `permissions-and-recovery.md`), tools and capabilities (`capabilities.md`), Git and artifacts (`artifacts-and-git.md`), prompt and tool configuration (`self-configuration.md`), troubleshooting (`troubleshooting.md`)',
    '- When working on Graph topics, read the docs and examples, and follow .md cross-references before implementing',
    '- Always read Graph .md files completely and follow links to related docs (for example `execution-model.md` before changing operation or recovery behavior)',
  ].join('\n');
}
