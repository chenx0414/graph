import { appendFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A report that the prompt a model really received is still whole.
 *
 * The Pi session builds most of the system prompt itself and chains
 * `before_agent_start` through every installed extension, so one extension that
 * returns a replacement instead of an addition silently drops whatever came
 * before it. That already happened once: Graph's own takeover wiped the
 * agent-browser project rule. The prompt is recorded at the provider call, so the
 * same place can check that the parts every send must carry are still there.
 *
 * This only reports. A send is never blocked, never retried and never rewritten:
 * the log is where a human and the next investigation look.
 */

/** Graph's own three sections plus the working directory the session appends. */
export const PROMPT_SECTIONS = ['<identity>', '<rules>', '<docs>', '<cwd>'] as const;

export interface PromptIntegrity {
  /** False when there was nothing to check, because no prompt went out. */
  checked: boolean;
  ok: boolean;
  missing: string[];
}

export function promptIntegrity(text: string | null, expected: readonly string[] = PROMPT_SECTIONS): PromptIntegrity {
  if (text === null) return { checked: false, ok: true, missing: [] };
  const missing = expected.filter(section => !text.includes(section));
  return { checked: true, ok: missing.length === 0, missing };
}

/**
 * Check one outgoing prompt and, when a part is missing, append a line to the
 * instance's report. Never throws: a diagnostic must not break a send.
 */
export async function reportPromptIntegrity(
  stateDir: string,
  operationId: string,
  text: string | null,
  expected: readonly string[] = PROMPT_SECTIONS,
): Promise<PromptIntegrity> {
  const result = promptIntegrity(text, expected);
  if (result.checked && !result.ok) {
    try {
      appendFileSync(join(stateDir, 'prompt-integrity.log'), `${JSON.stringify({
        at: Date.now(), operationId, missing: result.missing, characters: text?.length ?? 0,
      })}\n`);
    } catch { /* reporting must never break a send */ }
  }
  return result;
}
