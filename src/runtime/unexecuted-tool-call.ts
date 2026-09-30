/** A provider may emit its tool-call wire format as ordinary assistant text.
 * Match both observed parameter-opening variants by their complete closing sequence.
 * A fenced example is documentation, not a request to execute a tool. */
export function hasUnexecutedToolCall(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  return /<parameter\s+name="[\w.-]+">[\s\S]*<\/｜DSML｜\s+parameter>\s*<\/｜DSML｜\s+invoke>\s*<\/｜DSML｜\s+calls>\s*$/u.test(prose)
    || /<parameter\s+name="[\w.-]+">[\s\S]*<parameter\s+name="[\w.-]+">[\s\S]*<\/parameter>\s*<\/invoke>\s*(?:<\/analysis>)?\s*$/u.test(prose)
    // Some OpenAI-compatible providers emit only parameter tags, even for
    // several attempted calls. Two closed fields distinguish this from prose
    // mentioning a single parameter tag.
    || (prose.match(/<parameter\s+name="[\w.-]+">[\s\S]*?<\/parameter>/gu)?.length ?? 0) >= 2;
}

/** Keep narration before a leaked call; its parameter text was never executed. */
export function withoutUnexecutedToolCall(text: string): string {
  if (!hasUnexecutedToolCall(text)) return text;
  const unfenced = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, match => ' '.repeat(match.length));
  const start = unfenced.search(/<parameter\s+name="[\w.-]+">/u);
  return start < 0 ? text : `${text.slice(0, start).trimEnd()}\n[Unexecuted tool-call text omitted.]`;
}
