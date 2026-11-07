import type { TranscriptTool } from './transcript-model.ts';

function recordedSummary(name: string, summary: string) {
  const text = summary.trim();
  const prefix = `${name}:`;
  return text.startsWith(prefix) ? text.slice(prefix.length).trim() : text;
}

export function toolActivity(name: string, summary = '') {
  const recorded = recordedSummary(name, summary);
  if (/^mcp(?::|__|_|$)/i.test(name)) {
    return { kind: 'mcp', label: 'MCP 调用', name: recorded && recorded !== name ? recorded : name };
  }
  if (name === 'codemode') {
    return { kind: 'code', label: '代码模式', name: recorded && recorded !== name ? recorded : name };
  }
  if (name === 'desktop') {
    return { kind: 'desktop', label: '桌面', name: recorded && recorded !== name ? `· ${recorded}` : name };
  }
  const shell = name === 'bash' || name === 'run_command';
  const command = recorded;
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

export function toolGroupSummary(input: TranscriptTool[]) {
  const counts = {
    read: 0,
    run: 0,
    edit: 0,
    search: 0,
    browse: 0,
    other: 0,
    skill: 0,
    mcp: 0,
    desktop: 0,
    code: 0,
    failed: 0,
  };
  for (const tool of input) {
    const kind = toolActivity(tool.name, tool.summary).kind;
    if (kind === 'read' || kind === 'list') counts.read += 1;
    else if (kind === 'run') counts.run += 1;
    else if (kind === 'search') counts.search += 1;
    else if (kind === 'edit') counts.edit += 1;
    else if (kind === 'browse') counts.browse += 1;
    else if (kind === 'skill') counts.skill += 1;
    else if (kind === 'mcp') counts.mcp += 1;
    else if (kind === 'desktop') counts.desktop += 1;
    else if (kind === 'code') counts.code += 1;
    else counts.other += 1;
    if (tool.error) counts.failed += 1;
  }
  const parts: string[] = [];
  if (counts.read) parts.push(`读取 ${counts.read} 项`);
  if (counts.run) parts.push(`运行 ${counts.run} 条命令`);
  if (counts.edit) parts.push(`编辑 ${counts.edit} 个文件`);
  if (counts.search) parts.push(`搜索 ${counts.search} 次`);
  if (counts.browse) parts.push(`访问 ${counts.browse} 个页面`);
  if (counts.skill) parts.push(`读取 ${counts.skill} 个 Skill`);
  if (counts.mcp) parts.push(`MCP 调用 ${counts.mcp} 次`);
  if (counts.desktop) parts.push(`桌面 ${counts.desktop} 项`);
  if (counts.code) parts.push(`脚本 ${counts.code} 次`);
  if (counts.other) parts.push(`调用 ${counts.other} 个工具`);
  if (counts.failed) parts.push(`${counts.failed} 项失败`);
  return parts.join(' · ') || `${input.length} 个工具`;
}
