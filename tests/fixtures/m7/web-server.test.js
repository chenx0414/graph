import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createWebServer } from '../src/web-server.js';

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function seed() {
  const raw = path.join(process.cwd(), 'raw');
  const out = path.join(process.cwd(), 'output');
  fs.mkdirSync(path.join(out, 'bilibili-notes'), { recursive: true });
  fs.mkdirSync(raw, { recursive: true });
  fs.writeFileSync(path.join(raw, 'bilibili-fixture.json'), JSON.stringify({
    platform: 'bilibili',
    collectedAt: '2026-09-12T00:00:00.000Z',
    count: 1,
    items: [{
      schema: 'media-favorite/v1',
      platform: 'bilibili',
      platformLabel: '哔哩哔哩',
      id: 'BV_FIXTURE',
      title: 'Graph fixture video',
      url: 'https://www.bilibili.com/video/BV_FIXTURE',
      author: 'fixture',
    }],
  }));
  fs.writeFileSync(path.join(out, 'login-state.json'), JSON.stringify({
    bilibili: { hasKeyCookie: true, cookieCount: 2 },
  }));
  fs.writeFileSync(path.join(out, 'bilibili-notes', 'fixture.md'), '# Fixture note\n');
  fs.writeFileSync(path.join(out, 'bilibili.md'), '# 哔哩哔哩\n');
}

test('bilibili web shows login, collect progress, notes and export', async (t) => {
  process.env.GRAPH_FIXTURE = '1';
  seed();
  const server = createWebServer();
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const login = await (await fetch(`${base}/api/login-status`)).json();
  assert.equal(login.platform, 'bilibili');
  assert.equal(login.loggedIn, true);
  assert.equal(login.exclusiveCollect, true);
  assert.match(login.profile, /\.browser-profile$/);
  const page = await (await fetch(base)).text();
  assert.match(page, /独立 profile/);
  assert.match(page, /只允许一个采集任务/);
  const jobFile = path.join(process.cwd(), 'output', 'collect-job.json');
  fs.writeFileSync(jobFile, JSON.stringify({ status: 'running', progress: { current: 0, total: 1 }, failures: [] }));
  const busy = await fetch(`${base}/api/collect`, { method: 'POST' });
  assert.equal(busy.status, 409);
  fs.writeFileSync(jobFile, JSON.stringify({ status: 'idle', progress: { current: 0, total: 0 }, failures: [] }));
  const collected = await (await fetch(`${base}/api/collect`, { method: 'POST' })).json();
  assert.equal(collected.status, 'done');
  assert.ok(collected.failures.some((item) => item.reason.includes('字幕')));
  const favorites = await (await fetch(`${base}/api/favorites`)).json();
  assert.ok(favorites.count >= 1);
  const notes = await (await fetch(`${base}/api/notes`)).json();
  assert.ok(notes.notes.length >= 1 || notes.index);
  const exported = await (await fetch(`${base}/api/export`, { method: 'POST' })).json();
  assert.ok(exported.count >= 1);
});
