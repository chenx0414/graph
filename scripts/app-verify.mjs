/**
 * Assert that what must ship in the desktop shell and the served console is really inside the
 * packaged app.
 *
 * "It is in the source" and "it is in the build" are different claims. Measured: a shell fix existed
 * in the package while the app line's source did not have it, so the next build would have dropped
 * it silently - and the running process was a third state again (old code, since a process never
 * swaps itself out).
 *
 * Run: node --run app:verify   (after node --run app:build)
 *      node scripts/app-verify.mjs <checkout>/dist/app   for a package built in another checkout
 *
 * The marker list is a smoke set, not a coverage claim: add a marker when a change would be silent
 * if it never reached the package.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

const MARKERS = [
  ['consoleReloadAction', 'desktop：同一地址重载必须刷新文档'],
  ['showConsole', 'desktop：决定 reload 还是 navigate 的那层'],
  ['toolCallSpoolPath', 'worker 车道的工具调用落盘'],
  ['hoistTruncationNotice', '截断结果把提示提到最前'],
  ['preferredConsolePort', '重载保持控制台端口'],
  ['writeConsoleAddress', '控制台公布自己的地址'],
];

const SCAN_EXTENSIONS = ['.mjs', '.js', '.cjs', '.ts', '.tsx', '.json', '.html', '.css'];
const SKIP_DIRECTORIES = new Set(['node_modules', '.git', 'dist']);

const dist = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(import.meta.dirname, '..', 'dist', 'app');
const roots = existsSync(dist)
  ? readdirSync(dist)
    .map(name => join(dist, name, 'Graph.app', 'Contents', 'Resources', 'app'))
    .filter(path => existsSync(path))
  : [];
if (!roots.length) {
  console.error(`找不到打包产物，先跑 node --run app:build（期望 ${dist}/<arch>/Graph.app/Contents/Resources/app）`);
  process.exit(1);
}
const root = roots[0];

let failures = 0;
for (const [marker, why] of MARKERS) {
  const hits = grepTree(root, marker);
  if (!hits.length) failures += 1;
  console.log(`${hits.length ? 'ok  ' : 'FAIL'} ${marker.padEnd(24)} ${why}${hits.length ? `（${hits.length} 个文件）` : '（不在包里）'}`);
}
console.log(failures === 0 ? `\n产物核对通过：${root}` : `\n产物核对失败：${failures} 项`);
process.exit(failures === 0 ? 0 : 1);

function grepTree(directory, needle) {
  const hits = [];
  const walk = current => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name)) walk(join(current, entry.name));
        continue;
      }
      if (!SCAN_EXTENSIONS.some(extension => entry.name.endsWith(extension))) continue;
      const path = join(current, entry.name);
      try {
        if (readFileSync(path, 'utf8').includes(needle)) hits.push(path);
      } catch {
        // A file we cannot read as text cannot contain the marker.
      }
    }
  };
  walk(directory);
  return hits;
}
