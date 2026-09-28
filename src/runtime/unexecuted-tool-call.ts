/** A provider may emit its tool-call wire format as ordinary assistant text.
 * Match both observed parameter-opening variants by their complete closing sequence.
 * A fenced example is documentation, not a request to execute a tool. */
export function hasUnexecutedToolCall(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  return /<parameter\s+name="[\w.-]+">[\s\S]*<\/｜DSML｜\s+parameter>\s*<\/｜DSML｜\s+invoke>\s*<\/｜DSML｜\s+calls>\s*$/u.test(prose);
}
