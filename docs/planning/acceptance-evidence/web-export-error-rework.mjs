// Synthetic browser probe for delivery b1754fac. No login or external service.
// Exit 0 means the observation completed, not that the product passed.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

if (!process.argv[2]) throw new Error('Pass the delivery repository path');
const { startWebServer } = await import(pathToFileURL(resolve(process.argv[2], 'src/web/server.js')).href);
const root = await mkdtemp(join(tmpdir(), 'graph-export-review-'));
const rawDir = join(root, 'raw');
const notesDir = join(root, 'notes');
await mkdir(rawDir);
await mkdir(notesDir);
let server;
let browser;
try {
  server = await startWebServer({
    rawDir, notesDir,
    contextFactory: async () => { throw new Error('synthetic browser unavailable'); },
  });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(server.url);
  const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/export'));
  await page.locator('#export-btn').click();
  const response = await responsePromise;
  const body = await response.json();
  await page.waitForFunction(() => document.querySelector('#export-result').textContent !== '导出中…');
  const displayed = await page.locator('#export-result').textContent();
  assert.equal(response.status(), 500);
  assert.equal(body.error, 'synthetic browser unavailable');
  console.log(JSON.stringify({ httpStatus: response.status(), response: body, displayed,
    falselyClaimsSuccess: displayed.includes('导出完成'),
    displaysFailureReason: displayed.includes(body.error) }, null, 2));
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
