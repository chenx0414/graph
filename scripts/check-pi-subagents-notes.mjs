// Acceptance check for the simple-tier research task: three independent subagents each left a
// traceable note, and the fixture's own claims are backed by a primary source.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const notes = [
  { file: 'notes/pi-subagents-auth.md', topic: '授权模型' },
  { file: 'notes/pi-subagents-surface.md', topic: '工具面与工作流 API' },
  { file: 'notes/pi-subagents-lessons.md', topic: '可迁移教训' },
];

const problems = [];
for (const note of notes) {
  const path = join(root, note.file);
  if (!existsSync(path)) { problems.push(`${note.file} 不存在（${note.topic}）`); continue; }
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < 400) problems.push(`${note.file} 过短（${text.trim().length} 字符），不像一份调研笔记`);
  // Every note must cite where its claims come from.
  if (!/registry\.npmjs\.org|github\.com|docs\/|package\.json|CHANGELOG/.test(text)) {
    problems.push(`${note.file} 没有任何可回溯的来源引用`);
  }
}

if (problems.length) {
  console.log(JSON.stringify({ ok: false, problems }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, notes: notes.map(note => note.file) }, null, 2));
