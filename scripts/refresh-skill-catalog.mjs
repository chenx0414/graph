/**
 * Refresh the skill portion of presets/resources.json from the curated GitHub
 * sources. The script reads the repository tree through GitHub and fetches
 * only SKILL.md files, so it does not vendor third-party repositories.
 *
 * Run: node scripts/refresh-skill-catalog.mjs
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const resourcesPath = join(root, 'presets', 'resources.json');

const SOURCES = [
  {
    repo: 'obra/superpowers-skills',
    license: 'MIT',
    commercialUse: 'allowed',
    archived: true,
    tags: ['编码', '方法论', '软件工程'],
    importHint: '来源已归档；安装时固定 commit，并逐个核对技能子路径。',
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'garrytan/gstack',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['团队工作流', '产品', '交付'],
  },
  {
    repo: 'mattpocock/skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['TDD', '规范', '架构'],
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'mcncarl/yichen-skills',
    license: 'Custom non-commercial',
    commercialUse: 'restricted',
    tags: ['中文', '内容创作', '调研'],
  },
  {
    repo: 'American-Embedded/kistack',
    license: 'Unknown',
    commercialUse: 'unknown',
    tags: ['PRD', '多仓库', 'PR'],
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'luongnv89/skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['工程', '评审', '文档'],
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'tscircuit/skill',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['硬件', '电路', 'PCB'],
    rootOnly: true,
  },
  {
    repo: 'KKKKhazix/khazix-skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['中文', '效率', '写作'],
  },
  {
    repo: 'affaan-m/ECC',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['增强', '记忆', '安全'],
    importHint: '这是大型综合仓库；只选择明确的 skill 子路径，不要整仓导入。',
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'Fission-AI/OpenSpec',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['规范驱动', '需求', '变更'],
    importHint: '产品代码与技能混排；只提取已核对的 skill 子路径，不要整仓导入。',
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'anthropics/skills',
    license: 'Mixed; per-skill',
    commercialUse: 'mixed',
    tags: ['官方示例', 'Agent Skills'],
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'K-Dense-AI/scientific-agent-skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['科研', '生物医药', '数据分析'],
    pathPrefixes: ['skills/'],
  },
  {
    repo: 'VoltAgent/awesome-agent-skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['社区', '合集', '索引'],
    indexOnly: true,
  },
  {
    repo: 'Imbad0202/academic-research-skills',
    license: 'Unknown',
    commercialUse: 'unknown',
    tags: ['学术', '文献', '写作'],
  },
  {
    repo: 'Fokkyp/SoftwareCopyright-Skill',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['软著', '合规', '文档'],
    pathPrefixes: ['software-copyright-materials/'],
  },
  {
    repo: 'handsomestWei/patent-disclosure-skill',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['专利', '查新', '文档'],
  },
  {
    repo: 'kepano/obsidian-skills',
    license: 'MIT',
    commercialUse: 'allowed',
    tags: ['Obsidian', '知识库', '笔记'],
    pathPrefixes: ['skills/'],
  },
];

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 72) || 'skill';
}

function stableId(repo, path) {
  const stem = slug(`${repo}-${path.replace(/\/?SKILL\.md$/, '')}`);
  const digest = createHash('sha1').update(`${repo}:${path}`).digest('hex').slice(0, 8);
  return `skill-${stem}-${digest}`;
}

function frontmatter(text) {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!match) return {};
  const values = {};
  const lines = match[1].split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const parsed = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(lines[index]);
    if (!parsed) continue;
    const key = parsed[1];
    const raw = parsed[2].trim();
    if (raw === '>' || raw === '|') {
      const continuation = [];
      while (index + 1 < lines.length && /^\s+/.test(lines[index + 1])) {
        continuation.push(lines[index + 1].trim());
        index += 1;
      }
      values[key] = continuation.join(' ');
    } else {
      values[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
    }
  }
  return values;
}

function scriptRisk(tree, skillDirectory) {
  const prefix = skillDirectory === '.' ? '' : `${skillDirectory}/`;
  const code = tree.some(path => {
    if (!path.startsWith(prefix)) return false;
    return ['.py', '.sh', '.js', '.mjs', '.cjs', '.ts'].includes(extname(path));
  });
  return code ? ['code-execution'] : [];
}

async function inspectSource(source) {
  const remote = (await run('git', ['ls-remote', `https://github.com/${source.repo}.git`, 'HEAD'])).stdout.trim();
  const commit = remote.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Cannot resolve HEAD for ${source.repo}`);
  const treeText = (await run('gh', ['api', `repos/${source.repo}/git/trees/${commit}?recursive=1`, '--jq', '.tree[].path'], { maxBuffer: 64 * 1024 * 1024 })).stdout;
  const tree = treeText.split(/\r?\n/).filter(Boolean);
  const files = tree.filter(path => {
    if (!/(^|\/)SKILL\.md$/.test(path)) return false;
    if (source.rootOnly) return path === 'SKILL.md';
    if (source.pathPrefixes?.length) return source.pathPrefixes.some(prefix => path.startsWith(prefix));
    return true;
  }).sort();
  if (source.indexOnly || !files.length) {
    return [{
      id: `skill-index-${slug(source.repo)}`,
      kind: 'skill-index',
      name: `${source.repo.split('/')[1]}（发现索引）`,
      description: '这是社区技能发现列表，仓库本身没有 SKILL.md；请沿条目继续定位具体技能来源。',
      source: `https://github.com/${source.repo}`,
      sourceKind: 'github',
      sourceRepository: source.repo,
      resolvedCommit: commit,
      license: source.license,
      commercialUse: source.commercialUse,
      compatibility: 'unverified',
      tags: source.tags,
    }];
  }
  const contents = await mapLimit(files, 10, async file => {
    const url = `https://raw.githubusercontent.com/${source.repo}/${commit}/${file.split('/').map(encodeURIComponent).join('/')}`;
    const response = await fetch(url, { headers: { 'user-agent': 'Graph resource catalog refresh' } });
    if (!response.ok) throw new Error(`Cannot fetch ${source.repo}/${file}: HTTP ${response.status}`);
    return [file, await response.text()];
  });
  const entries = [];
  for (const [file, text] of contents) {
    const metadata = frontmatter(text);
    const skillDirectory = dirname(file);
    const pathLabel = skillDirectory === '.' ? file : skillDirectory;
    const fallbackName = skillDirectory === '.' ? source.repo.split('/')[1] : skillDirectory.split('/').at(-1);
    const requirements = metadata.compatibility ? [metadata.compatibility] : [];
    const risk = scriptRisk(tree, skillDirectory);
    entries.push({
      id: stableId(source.repo, file),
      kind: 'skill',
      name: metadata.name || fallbackName,
      description: metadata.description || `来自 ${source.repo} 的 Skill：${pathLabel}`,
      source: `https://github.com/${source.repo}/blob/${commit}/${file}`,
      sourceKind: 'github',
      sourceRepository: source.repo,
      sourcePath: pathLabel,
      resolvedCommit: commit,
      ...(metadata.version ? { version: metadata.version } : {}),
      license: metadata.license || source.license,
      commercialUse: source.commercialUse,
      compatibility: 'unverified',
      ...(source.archived ? { archived: true } : {}),
      ...(requirements.length ? { requirements } : {}),
      ...(risk.length ? { risk } : {}),
      ...(source.importHint ? { importHint: source.importHint } : {}),
      tags: [...new Set([...source.tags, ...(skillDirectory === '.' ? [] : [skillDirectory.split('/')[0]])])],
    });
  }
  return entries;
}

async function mapLimit(items, limit, action) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await action(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const current = JSON.parse(await readFile(resourcesPath, 'utf8'));
const retained = current.entries.filter(entry => entry.kind !== 'skill' && entry.kind !== 'skill-index');
const skills = [];
for (const source of SOURCES) {
  process.stdout.write(`scanning ${source.repo}\n`);
  skills.push(...await inspectSource(source));
}
const document = {
  version: 1,
  updatedAt: new Date().toISOString().slice(0, 10),
  entries: [...skills, ...retained],
};
await writeFile(resourcesPath, `${JSON.stringify(document, null, 2)}\n`);
console.log(`wrote ${skills.length} skill entries and retained ${retained.length} other entries`);
