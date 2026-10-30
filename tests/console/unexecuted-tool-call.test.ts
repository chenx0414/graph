import { describe, expect, test } from 'vitest';
import { hasUnexecutedToolCall, withoutUnexecutedToolCall } from '../../src/web/unexecuted-tool-call.ts';

const first = `There it is. Let me check the earlier path.\n\n<parameter name="bash">\n<｜DSML｜ parameter name="command" string="true">grep -n unknown_usage src/core/operation-lifecycle.ts</｜DSML｜ parameter>\n<｜DSML｜ parameter name="timeout" string="false">300</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
const second = `I found the test fixture problem. Let me inspect it.\n\n<parameter name="bash">\n<｜DSML｜ parameter name="command" string="true">grep -n reservation tests/console/operation-lifecycle.test.ts</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
const directCommand = `The code looks right. Let me check the selector.\n\n<parameter name="bash">cd /repo && python3 - <<'PY'\nprint('inspect')\nPY</｜DSML｜ parameter>\n<｜DSML｜ parameter name="timeout" string="false">400</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>`;
const plainXmlCall = `I need to inspect the parser. <analysis>Let me find its implementation.</analysis>\n<parameter name="bash"><parameter name="command">rg parseStreamingJson src</parameter><parameter name="timeoutMs">60</parameter></invoke></analysis>`;
const bareParameters = 'Building v31.\n<parameter name="path">/tmp/shape-a-v31.json</parameter>\n<parameter name="content">{"loops":[]}</parameter>\nLet me call the tool.';

describe('unexecuted tool calls', () => {
  test('recognizes both captured final reply shapes without treating quoted examples as calls', () => {
    expect(hasUnexecutedToolCall(first)).toBe(true);
    expect(hasUnexecutedToolCall(second)).toBe(true);
    expect(hasUnexecutedToolCall(directCommand)).toBe(true);
    expect(hasUnexecutedToolCall(plainXmlCall)).toBe(true);
    expect(hasUnexecutedToolCall(bareParameters)).toBe(true);
    expect(withoutUnexecutedToolCall(bareParameters)).toBe('Building v31.\n[Unexecuted tool-call text omitted.]');
    expect(hasUnexecutedToolCall(`Example:\n\`\`\`xml\n${bareParameters}\n\`\`\``)).toBe(false);
    expect(hasUnexecutedToolCall(`Here is an example:\n\n\`\`\`text\n${first}\n\`\`\``)).toBe(false);
    expect(hasUnexecutedToolCall(`Here is an example:\n\n\`\`\`text\n${directCommand}\n\`\`\``)).toBe(false);
    expect(hasUnexecutedToolCall('The <parameter name="bash"> tag is part of a format description.')).toBe(false);
    expect(hasUnexecutedToolCall('<parameter name="bash">echo incomplete</｜DSML｜ parameter>')).toBe(false);
  });

});
