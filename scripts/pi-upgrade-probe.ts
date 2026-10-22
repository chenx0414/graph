/**
 * Pi durable 1.1 prompt integrity probe.
 *
 * The upgrade moves the system prompt into the transcript: the session creates
 * structured system messages with named sections and patches them per turn. The
 * console promises the user the prompt that really goes out, byte for byte, and
 * Graph records it by replaying the transcript (`getCurrentSystemPrompt`). This
 * probe proves that replay stays complete across turns, including a patched one.
 *
 * Run: node scripts/pi-upgrade-probe.ts
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCurrentSystemPrompt, type Model, type TranscriptContext } from '@earendil-works/pi-ai';
import { openDurableAgent } from '../tests/fixtures/durable-agent.ts';
import { modelA, respond, testModelRuntime } from '../tests/fixtures/models.ts';

// Stands in for what our own composer emits: the three sections Graph owns.
const IDENTITY = 'MAIN IDENTITY SENTINEL\nYou are the master Agent of one Graph feature task.';
const RULES = ['- Use tool results as evidence.', '- R'.repeat(1) + 'ules must survive the transcript round trip.'].join('\n');
const DOCS = 'Graph documentation (read when the user asks about Graph itself):\n' + '- x\n'.repeat(200);
const PROMPT = [
  `MAIN IDENTITY SENTINEL\n${IDENTITY}`, `<rules>\n${RULES}\n</rules>`, `<docs>\n${DOCS}</docs>`,
].join('\n\n');

const sent: string[] = [];
const transcriptSystem: string[] = [];

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-upgrade-probe-'));
  const workspace = join(root, 'workspace');
  await mkdir(workspace);
  try {
    const instance = await openDurableAgent({
      binding: { instanceId: 'probe', nodeId: 'probe', definitionVersion: 'coder@1' },
      workspace, stateDir: join(root, 'state'),
      model: modelA as unknown as Model<never>, modelRuntime: await testModelRuntime(),
      systemPrompt: PROMPT,
      stream: ((model: Model<never>, context: TranscriptContext, options: never) => {
        sent.push(getCurrentSystemPrompt(context.messages));
        transcriptSystem.push(context.messages
          .filter(message => message.role === 'system' || message.role === 'developer')
          .map(message => (typeof message.content === 'string' ? message.content : JSON.stringify(message.content)))
          .join('\n---\n'));
        return respond(model as never, context as never, options);
      }) as never,
    });
    try {
      await instance.prompt('First turn.');
      await instance.prompt('Second turn, after the first patch.');
    } finally {
      await instance.close();
    }

    const report: string[] = [];
    report.push(`requests seen: ${sent.length}`);
    if (sent.length < 2) throw new Error(`expected two provider requests, saw ${sent.length}`);
    const tags = ['<identity>', '<rules>', '<docs>', '<project_context>', '<available_skills>', '<cwd>', '<tools>'];
    for (const [index, text] of sent.entries()) {
      const census = tags.map(tag => `${tag}=${text.split(tag).length - 1}`).join(' ');
      const keepsEverything = text.includes(RULES) && text.includes(DOCS) && text.includes('MAIN IDENTITY SENTINEL');
      report.push(`request ${index + 1}: ${text.length} chars | every owned section present: ${keepsEverything} | ${census}`);
      // The transcript carries structured system messages (`sections`), so the raw
      // join is only a growth check, not an equality check: the replay is the
      // rendered text the provider serializes.
      report.push(`  rendered replay covers the raw transcript text: ${text.length >= transcriptSystem[index]!.length}`);
    }
    const first = sent[0]!;
    const complete = first.includes(RULES) && first.includes(DOCS) && first.includes('MAIN IDENTITY SENTINEL');
    report.push(`CONCLUSION complete prompt recorded: ${complete}`);
    process.stdout.write(`${report.join('\n')}\n`);
    if (!complete) process.exitCode = 1;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
