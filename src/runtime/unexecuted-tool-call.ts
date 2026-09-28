/** A provider may emit its tool-call wire format as ordinary assistant text.
 * This is the complete, trailing call shape seen in live DeepSeek replies.
 * A fenced example is documentation, not a request to execute a tool. */
export function hasUnexecutedToolCall(text: string): boolean {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  return /<parameter\s+name="[\w.-]+">\s*<｜DSML｜\s+parameter\b[\s\S]*?<\/｜DSML｜\s+invoke>\s*<\/｜DSML｜\s+calls>\s*$/u.test(prose);
}
