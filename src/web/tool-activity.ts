/** Labels describe the observed call; shell commands keep their real executor. */
export function toolActivity(name: string, summary = '') {
  if (/^mcp(?::|__|_|$)/i.test(name)) return { kind: 'mcp', label: 'MCP 调用', name };
  const shell = name === 'bash' || name === 'run_command';
  const command = summary.replace(/^(?:bash|run_command):\s*/, '').trim();
  // Deliberately avoid interpreting compound shell programs as one tool.
  const simple = !/[;&|`\n]|\$\(/.test(command);
  const executable = simple ? /^(?:\/[^\s]+\/)?([\w.-]+)(?:\s|$)/.exec(command)?.[1] : undefined;
  const actual = shell ? executable ?? name : name;
  if ((actual === 'read' || actual === 'cat' || actual === 'head' || actual === 'sed') && /(?:^|\/)SKILL\.md(?:[\s"']|$)/i.test(summary)) {
    return { kind: 'skill', label: '读取 Skill', name: shell ? `${name} · ${actual}` : name };
  }
  const kind = ['read', 'cat', 'head', 'tail', 'sed'].includes(actual) ? 'read'
    : ['grep', 'rg', 'search', 'glob', 'find'].includes(actual) ? 'search'
    : ['ls', 'list_dir'].includes(actual) ? 'list'
    : ['edit', 'write', 'write_file', 'apply_patch'].includes(actual) ? 'edit'
    : ['fetch', 'web_search'].includes(actual) ? 'browse'
    : shell ? 'run' : 'other';
  const label = { read: '读取', search: '搜索', list: '列目录', edit: '编辑', browse: '浏览', run: '运行', other: '调用' }[kind];
  return { kind, label, name: shell && executable ? `${name} · ${executable}` : name };
}
