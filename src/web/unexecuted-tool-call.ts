export function hasUnexecutedToolCall(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
  return /<parameter\s+name="[\w.-]+">[\s\S]*<\/｜DSML｜\s+parameter>\s*<\/｜DSML｜\s+invoke>\s*<\/｜DSML｜\s+calls>\s*$/u.test(prose)
    || /<parameter\s+name="[\w.-]+">[\s\S]*<parameter\s+name="[\w.-]+">[\s\S]*<\/parameter>\s*<\/invoke>\s*(?:<\/analysis>)?\s*$/u.test(prose)
    || (prose.match(/<parameter\s+name="[\w.-]+">[\s\S]*?<\/parameter>/gu)?.length ?? 0) >= 2;
}

export function withoutUnexecutedToolCall(text: string): string {
  if (!hasUnexecutedToolCall(text)) return text;
  const unfenced = text.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, match => ' '.repeat(match.length));
  const start = unfenced.search(/<parameter\s+name="[\w.-]+">/u);
  return start < 0 ? text : `${text.slice(0, start).trimEnd()}\n[Unexecuted tool-call text omitted.]`;
}
