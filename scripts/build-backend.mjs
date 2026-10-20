/**
 * Build the Go backend into `dist/graphd`.
 *
 * The APP backend is the Go program under `backend/`. Everything that runs it -
 * `npm start`, the E2E harness, the desktop shell - needs that binary, and the
 * binary was previously only produced by an ad-hoc command nobody could repeat
 * from a clean checkout. This script is that command, written down.
 *
 * Run: `node --run build:backend`
 *      `node scripts/build-backend.mjs --if-missing` (build only when stale)
 *      `node scripts/build-backend.mjs --print-path` (print the target path, build nothing)
 *
 * Exit codes: 0 = the binary is present and current, 1 = the build failed or
 * the Go toolchain is missing.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const moduleDir = join(root, 'backend');
const commandPackage = './cmd/graphd';
const output = join(root, 'dist', process.platform === 'win32' ? 'graphd.exe' : 'graphd');

const flags = new Set(process.argv.slice(2).filter(argument => argument.startsWith('--')));
const printPathOnly = flags.has('--print-path');
const onlyIfStale = flags.has('--if-missing');

if (printPathOnly) {
  console.log(output);
  process.exit(0);
}

if (!existsSync(join(moduleDir, 'go.mod'))) {
  console.error(`找不到 Go 模块目录 ${moduleDir}`);
  process.exit(1);
}

if (onlyIfStale && existsSync(output) && !isStale()) {
  console.log(`[graph] 后端已是最新：${output}`);
  process.exit(0);
}

// `dist/` is ignored, so a clean checkout has no output directory at all.
mkdirSync(join(root, 'dist'), { recursive: true });
const build = spawnSync('go', ['build', '-trimpath', '-o', output, commandPackage], {
  cwd: moduleDir,
  stdio: 'inherit',
});
if (build.error?.code === 'ENOENT') {
  console.error('找不到 go 命令：安装 Go 工具链后重跑 node --run build:backend');
  process.exit(1);
}
if (build.status !== 0) {
  console.error(`[graph] 后端构建失败（go build 退出码 ${build.status}）`);
  process.exit(1);
}

console.log(`[graph] 后端已构建：${output}`);
process.exit(0);

/** True when any Go source under `backend/` is newer than the built binary. */
function isStale() {
  const built = statSync(output).mtimeMs;
  return ['go.mod', 'go.sum'].some(file => statSync(join(moduleDir, file)).mtimeMs > built)
    || statSync(fileURLToPath(import.meta.url)).mtimeMs > built
    || newestSource(join(moduleDir, 'cmd')) > built || newestSource(join(moduleDir, 'internal')) > built;
}

/** The newest modification time among the `.go` files under a directory. */
function newestSource(directory) {
  let newest = 0;
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith('.go')) continue;
      const modified = statSync(path).mtimeMs;
      if (modified > newest) newest = modified;
    }
  };
  if (existsSync(directory)) walk(directory);
  return newest;
}
