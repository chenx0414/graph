// B站本机 Web：复用 CLI 的登录态文件、采集、导出与笔记目录。
// 浏览器 profile 固定为项目内 .browser-profile，同一时刻只允许一个采集任务。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { config, ensureDir, readJson, writeJson } from './config.js';

const ROOT = config.root;
const PROFILE = path.join(ROOT, '.browser-profile');
function usingFixture() {
  return process.env.GRAPH_FIXTURE === '1';
}
const JOB_FILE = path.join(config.outputDir, 'collect-job.json');
const PAGE = path.join(ROOT, 'src', 'web', 'index.html');

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function loginStatus() {
  const state = readJson(path.join(config.outputDir, 'login-state.json'), {});
  const bili = state.bilibili || { hasKeyCookie: false, cookieCount: 0 };
  return {
    platform: 'bilibili',
    loggedIn: Boolean(bili.hasKeyCookie),
    cookieCount: bili.cookieCount || 0,
    profile: PROFILE,
    exclusiveCollect: true,
    note: '采集使用项目内独立 profile，不复用日常 Chrome，也不并发展开第二次采集。',
  };
}

function latestRaw() {
  ensureDir(config.rawDir);
  const files = fs.readdirSync(config.rawDir).filter((name) => name.startsWith('bilibili') && name.endsWith('.json')).sort();
  const file = files[files.length - 1];
  if (!file) return { count: 0, items: [] };
  const data = readJson(path.join(config.rawDir, file), { items: [] });
  return { file, count: (data.items || []).length, items: data.items || [] };
}

function notesDir() {
  return path.join(config.outputDir, 'bilibili-notes');
}

function listNotes() {
  const dir = notesDir();
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.md')) : [];
  const index = path.join(config.outputDir, 'bilibili.md');
  return {
    notes: files.map((name) => ({ name, path: path.join('output', 'bilibili-notes', name), href: `/api/notes/content?name=${encodeURIComponent(name)}` })),
    index: fs.existsSync(index) ? 'output/bilibili.md' : null,
  };
}

function readNote(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || !base.endsWith('.md')) {
    const error = new Error('Invalid note name');
    error.code = 'invalid_note';
    throw error;
  }
  const dir = path.resolve(notesDir());
  const file = path.resolve(dir, base);
  if (file !== dir && !file.startsWith(`${dir}${path.sep}`)) {
    const error = new Error('Invalid note name');
    error.code = 'invalid_note';
    throw error;
  }
  if (!fs.existsSync(file)) {
    const error = new Error('Note not found');
    error.code = 'not_found';
    throw error;
  }
  return { name: base, content: fs.readFileSync(file, 'utf8') };
}

function readJob() {
  return readJson(JOB_FILE, { status: 'idle', progress: { current: 0, total: 0 }, failures: [] });
}

function writeJob(job) {
  ensureDir(config.outputDir);
  writeJson(JOB_FILE, job);
}

function startLiveCollect() {
  const args = ['src/cli.js', 'collect', 'bilibili'];
  if (config.targets.bilibiliUid) args.push(`--uid=${config.targets.bilibiliUid}`);
  const child = spawn(process.execPath, args, { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    const text = String(chunk);
    const match = /(\d+)\s*\/\s*(\d+)/.exec(text);
    const job = readJob();
    if (job.status !== 'running') return;
    if (match) writeJob({ ...job, progress: { current: Number(match[1]), total: Number(match[2]) } });
    else {
      const current = (job.progress && job.progress.current) || 0;
      writeJob({ ...job, progress: { current: current + 1, total: Math.max((job.progress && job.progress.total) || 1, current + 1) } });
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.on('close', (code) => {
    if (code === 0) {
      const job = readJob();
      writeJob({ status: 'done', progress: job.progress || { current: 1, total: 1 }, failures: [], finishedAt: new Date().toISOString() });
    } else {
      writeJob({ status: 'failed', progress: { current: 0, total: 1 }, failures: [{ id: 'collect', reason: stderr.trim() || `exit ${code}` }] });
    }
  });
}

async function startCollect() {
  if (!loginStatus().loggedIn) {
    const error = new Error('B站未登录');
    error.code = 'not_logged_in';
    throw error;
  }
  const current = readJob();
  if (current.status === 'running') {
    const error = new Error('A collect job is already running');
    error.code = 'collect_busy';
    throw error;
  }
  writeJob({ status: 'running', progress: { current: 0, total: 1 }, failures: [], startedAt: new Date().toISOString() });
  if (usingFixture()) {
    const fixture = path.join(ROOT, 'raw', 'bilibili-fixture.json');
    ensureDir(config.rawDir);
    if (fs.existsSync(fixture)) {
      fs.copyFileSync(fixture, path.join(config.rawDir, `bilibili-${Date.now()}.json`));
    }
    writeJob({
      status: 'done',
      progress: { current: 2, total: 2 },
      failures: [{ id: 'BV_FIXTURE_FAIL', reason: '字幕不可用' }],
      finishedAt: new Date().toISOString(),
    });
    return readJob();
  }
  startLiveCollect();
  return readJob();
}

async function runExport() {
  const { runExport } = await import('./commands/export.js');
  return runExport({ outDir: config.outputDir, merge: false });
}

export function createWebServer() {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && url.pathname === '/api/login-status') return send(res, 200, loginStatus());
      if (req.method === 'GET' && url.pathname === '/api/job') return send(res, 200, readJob());
      if (req.method === 'GET' && url.pathname === '/api/favorites') return send(res, 200, latestRaw());
      if (req.method === 'GET' && url.pathname === '/api/notes') return send(res, 200, listNotes());
      if (req.method === 'GET' && url.pathname === '/api/notes/content') {
        try { return send(res, 200, readNote(url.searchParams.get('name'))); }
        catch (error) { return send(res, error.code === 'not_found' ? 404 : 400, { error: error.message }); }
      }
      if (req.method === 'POST' && url.pathname === '/api/collect') {
        try {
          const job = await startCollect();
          return send(res, job.status === 'running' ? 202 : 200, job);
        }
        catch (error) {
          const status = error.code === 'collect_busy' || error.code === 'not_logged_in' ? 409 : 500;
          return send(res, status, { error: error.message, code: error.code });
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/export') return send(res, 200, await runExport());
      send(res, 404, { error: 'not found' });
    } catch (error) {
      send(res, 500, { error: String(error.message || error) });
    }
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const server = createWebServer();
  const port = Number(process.env.PORT || 8787);
  server.listen(port, '127.0.0.1', () => {
    console.log(`MediaBookmarks B站 Web: http://127.0.0.1:${port}`);
  });
}
