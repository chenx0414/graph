import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium, type Locator, type Page } from 'playwright';
import { openGraphServer } from '../../src/server/host.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
let webDir: string;
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-composer-e2e-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

/** An external model server that pauses between real SSE answer deltas. */
async function streamingProvider(answer: string, pending: Promise<void>) {
  const base = await openaiServer([]);
  const requests: unknown[] = [];
  const wire = createServer(async (request, response) => {
    const buffers: Buffer[] = [];
    for await (const part of request) buffers.push(part);
    requests.push(JSON.parse(Buffer.concat(buffers).toString()));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish_reason: string | null, usage?: unknown) => {
      response.write(`data: ${JSON.stringify({ id: 'composer-response', choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`);
    };
    if (requests.length === 1) {
      chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-project', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'src/one.ts' }) } }] }, null);
      chunk({}, 'tool_calls', { prompt_tokens: 40, completion_tokens: 10 });
    } else {
      chunk({ role: 'assistant', content: answer.slice(0, 10) }, null);
      await pending;
      chunk({ content: answer.slice(10) }, null);
      chunk({}, 'stop', { prompt_tokens: 40, completion_tokens: 10 });
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => wire.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(wire.address() as AddressInfo).port}/v1`;
  const model = { ...base.model, provider: 'composer-stream', baseUrl };
  base.runtime.registerProvider(model.provider, { baseUrl, api: 'openai-completions', apiKey: 'scripted-local-key', models: [model] });
  return { ...base, model, requests, async close() {
    wire.closeAllConnections();
    await new Promise<void>((resolve, reject) => wire.close(error => error ? reject(error) : resolve()));
    await base.close();
  } };
}

async function harness(plans?: ResponsePlan[] | { answer: string; pending: Promise<void> }, delivery?: { final: Promise<void>; delta: () => void }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-composer-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'one.ts'), 'export const one = 1;\n');
  await writeFile(join(root, 'src', 'two.ts'), 'export const two = 2;\n');
  const provider = plans ? Array.isArray(plans) ? await openaiServer(plans) : await streamingProvider(plans.answer, plans.pending) : undefined;
  if (provider) cleanup.push(() => provider.close());
  const server = await openGraphServer({
    stateDir: join(root, 'state'), projects: [{ id: 'alpha', root }], webDir,
    autoDrive: Boolean(provider),
    startup: { mode: provider ? 'execute' : 'view', configured: true, modelCount: 1, enabledModelCount: 1 },
    ...(provider ? {
      models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'high' as const, api: 'openai-completions' as const,
        baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    } : {}),
  });
  cleanup.push(() => server.close());
  if (provider) server.runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'composer-master');
  let browserUrl = server.url;
  if (delivery) {
    let sawDelta = false;
    const proxy = createServer(async (request, response) => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(chunk);
      const headers = new Headers();
      for (const [key, item] of Object.entries(request.headers)) {
        if (item !== undefined && !['host', 'connection', 'content-length', 'transfer-encoding'].includes(key)) headers.set(key, Array.isArray(item) ? item.join(', ') : item);
      }
      const upstream = await fetch(`${server.url}${request.url}`, { method: request.method ?? 'GET', headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      response.writeHead(upstream.status, Object.fromEntries(upstream.headers));
      if (request.url?.includes('/events/stream') && upstream.body) {
        response.flushHeaders();
        const reader = upstream.body.getReader();
        let pending = Buffer.alloc(0);
        try {
          while (!response.destroyed) {
            const part = await reader.read();
            if (part.done) break;
            pending = Buffer.concat([pending, Buffer.from(part.value)]);
            let boundary: number;
            while ((boundary = pending.indexOf('\n\n')) !== -1) {
              const frame = pending.subarray(0, boundary + 2); pending = pending.subarray(boundary + 2);
              const raw = frame.toString('utf8').trim();
              const event = raw.startsWith('data: ') ? JSON.parse(raw.slice(6)) as { type?: string } : undefined;
              if (event?.type === 'message.delta') { sawDelta = true; response.write(frame); delivery.delta(); }
              else { if (sawDelta) await delivery.final; response.write(frame); }
            }
          }
          if (pending.length) response.write(pending);
        } catch (error) {
          if (!response.destroyed) response.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally { reader.releaseLock(); }
      } else {
        const body = await upstream.arrayBuffer();
        // Delay genuine later snapshots as well: a refresh timer from an older
        // event must not overtake the final event bytes held on the SSE link.
        if (sawDelta && request.method === 'GET' && /^\/api\/conversations\/[^/?]+(?:\?|$)/.test(request.url ?? '')) await delivery.final;
        if (!response.destroyed) response.write(Buffer.from(body));
      }
      response.end();
    });
    await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
    browserUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
    cleanup.push(async () => { proxy.closeAllConnections(); await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())); });
  }
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'], extraHTTPHeaders: { origin: browserUrl } });
  const page = await context.newPage();
  // Establish the normal browser session before exercising command endpoints.
  expect((await page.request.get(browserUrl)).ok()).toBe(true);
  async function conversation(text = 'Composer history', projectId?: string) {
    const response = await page.request.post(`${browserUrl}/api/conversations`, { data: { text, ...(projectId ? { projectId } : {}), requestId: crypto.randomUUID() } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json() as { conversationId: string }).conversationId;
  }
  async function open(id: string) {
    await page.goto(`${browserUrl}/#/conversations/${id}`);
    await page.getByTestId('chat-input').waitFor();
    return page.getByTestId('chat-input');
  }
  return { root, server, url: browserUrl, page, context, provider, conversation, open };
}

function value(input: Locator) {
  return input.evaluate((element: HTMLTextAreaElement) => element.value);
}
async function selection(input: Locator, start: number, end = start) {
  await input.evaluate((element: HTMLTextAreaElement, range) => { element.focus(); element.setSelectionRange(range.start, range.end); }, { start, end });
}
async function clipboard(page: Page, text: string) {
  await page.evaluate(text => navigator.clipboard.writeText(text), text);
}
async function paste(page: Page, input: Locator, text: string) {
  await clipboard(page, text);
  await input.dispatchEvent('contextmenu');
}

test('copy and right-click paste preserve source bytes and report real clipboard permission failures', async () => {
  const markdown = '# Heading\n\n- **bold** and `code`';
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const h = await harness({ answer: markdown, pending });
  // Always release the provider before closing its active HTTP response.
  cleanup.push(async () => { finish(); });
  const source = 'Original\nsecond line';
  const id = await h.conversation(source, 'alpha');
  const input = await h.open(id);
  await expect.poll(() => h.provider?.requests.length, { timeout: 30_000 }).toBe(2);
  // The host currently returns compact IPC frames after settlement. While the
  // actual provider response is incomplete, no completed answer may be copied.
  // This checks the real presentation boundary rather than injecting a stream row.
  await h.page.getByText('正在思考…', { exact: true }).waitFor();
  expect(await h.page.locator('[data-testid="message-assistant"] [data-testid="message-copy"], [data-testid="streaming"] [data-testid="message-copy"]').count()).toBe(0);
  const tools = h.page.getByTestId('tool-activity-group');
  await expect.poll(() => tools.count()).toBeGreaterThan(0);
  expect(await tools.getByTestId('message-copy').count()).toBe(0);
  finish();
  const answer = h.page.getByTestId('message-assistant').last();
  await expect.poll(() => answer.getByTestId('message-copy').count(), { timeout: 30_000 }).toBe(1);
  await answer.getByTestId('message-copy').click();
  await expect.poll(() => h.page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  await h.page.getByTestId('message-user').first().getByTestId('message-copy').click();
  await expect.poll(() => h.page.evaluate(() => navigator.clipboard.readText())).toBe(source);
  await expect.poll(() => h.page.locator('.toast').last().innerText()).toContain('已复制');
  expect(await h.page.locator('[data-role="system"] [data-testid="message-copy"], [data-testid="tool-group"] [data-testid="message-copy"]').count()).toBe(0);

  await input.fill('hello world');
  await selection(input, 5);
  await paste(h.page, input, ' brave');
  await expect.poll(() => value(input)).toBe('hello brave world');
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(11);
  await selection(input, 6, 11);
  await paste(h.page, input, 'there');
  await expect.poll(() => value(input)).toBe('hello there world');
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(11);
  await selection(input, 6, 11);
  const noticeBeforeEmpty = await h.page.locator('.toast').allTextContents();
  await paste(h.page, input, '');
  expect(await value(input)).toBe('hello there world');
  expect(await input.evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([6, 11]);
  expect(await h.page.locator('.toast').allTextContents()).toEqual(noticeBeforeEmpty);

  // Deny the browser capability itself; the application clipboard path stays real.
  const cdp = await h.context.newCDPSession(h.page);
  const { targetInfo } = await cdp.send('Target.getTargetInfo');
  const browserContextId = targetInfo.browserContextId;
  if (!browserContextId) throw new Error('Permission control requires the isolated browser context');
  await cdp.send('Browser.setPermission', { permission: { name: 'clipboard-read' }, setting: 'denied', origin: h.server.url, browserContextId });
  await input.dispatchEvent('contextmenu');
  await expect.poll(() => h.page.locator('.toast').last().innerText()).toContain('读不到剪贴板');
  expect(await value(input)).toBe('hello there world');
  await cdp.send('Browser.setPermission', { permission: { name: 'clipboard-write' }, setting: 'denied', origin: h.server.url, browserContextId });
  await answer.getByTestId('message-copy').click();
  await expect.poll(() => h.page.locator('.toast').last().innerText()).toContain('复制失败');
}, 60_000);

test('typing, paste, deletion and clear undo as user actions, with redo invalidated by an edit', async () => {
  const h = await harness();
  const input = await h.open(await h.conversation());
  await input.pressSequentially('hello');
  await input.press('ControlOrMeta+z');
  await expect.poll(() => value(input)).toBe('');
  await input.press('ControlOrMeta+Shift+z');
  await expect.poll(() => value(input)).toBe('hello');
  await selection(input, 5);
  await paste(h.page, input, ' world');
  await expect.poll(() => value(input)).toBe('hello world');
  await input.press('ControlOrMeta+z');
  await expect.poll(() => value(input)).toBe('hello');
  await input.press('Backspace');
  await expect.poll(() => value(input)).toBe('hell');
  await input.press('ControlOrMeta+z');
  await expect.poll(() => value(input)).toBe('hello');
  await input.press('ControlOrMeta+a');
  await input.press('Backspace');
  await expect.poll(() => value(input)).toBe('');
  await input.press('ControlOrMeta+z');
  await expect.poll(() => value(input)).toBe('hello');
  await input.press('ControlOrMeta+z');
  await input.pressSequentially('other');
  const edited = await value(input);
  await input.press('ControlOrMeta+Shift+z');
  expect(await value(input)).toBe(edited);
}, 60_000);

test('undo and redo keep the latest 100 independent paste actions', async () => {
  const h = await harness();
  const input = await h.open(await h.conversation());
  for (let index = 0; index < 125; index++) {
    await selection(input, (await value(input)).length);
    await paste(h.page, input, `${index},`);
    await expect.poll(() => value(input)).toBe(Array.from({ length: index + 1 }, (_, n) => `${n},`).join(''));
  }
  for (let count = 0; count < 100; count++) await input.press('ControlOrMeta+z');
  const earliest = Array.from({ length: 25 }, (_, n) => `${n},`).join('');
  await expect.poll(() => value(input)).toBe(earliest);
  await input.press('ControlOrMeta+z');
  expect(await value(input)).toBe(earliest);
  for (let count = 0; count < 100; count++) await input.press('ControlOrMeta+Shift+z');
  await expect.poll(() => value(input)).toBe(Array.from({ length: 125 }, (_, n) => `${n},`).join(''));
}, 120_000);

test('prompt history survives reload, restores drafts and restarts from newest after recalled submission', async () => {
  const h = await harness();
  const id = await h.conversation('first', 'alpha');
  for (const text of ['second', 'second', 'third']) {
    expect((await h.page.request.post(`${h.server.url}/api/conversations/${id}/messages`, { data: { text, requestId: crypto.randomUUID() } })).ok()).toBe(true);
  }
  const input = await h.open(id);
  await input.fill('unfinished');
  await selection(input, 0);
  for (const text of ['third', 'second', 'first', 'first']) {
    await input.press('ArrowUp');
    await expect.poll(() => value(input)).toBe(text);
  }
  for (const text of ['second', 'third', 'unfinished']) {
    await input.press('ArrowDown');
    await expect.poll(() => value(input)).toBe(text);
  }
  await selection(input, 0);
  await input.press('ArrowUp');
  await input.press('Enter');
  await expect.poll(() => value(input)).toBe('');
  await input.press('ArrowUp');
  await expect.poll(() => value(input)).toBe('third');
  await input.fill('edited recalled prompt');
  await selection(input, 0);
  await input.press('ArrowUp');
  await expect.poll(() => value(input)).toBe('third');
  await input.press('ArrowDown');
  await expect.poll(() => value(input)).toBe('edited recalled prompt');
  await input.fill('/');
  await h.page.getByTestId('slash-popover').waitFor();
  await input.press('ArrowUp');
  expect(await value(input)).toBe('/');
  await input.fill('@src/');
  await h.page.getByTestId('mention-popover').waitFor();
  await input.press('ArrowDown');
  expect(await value(input)).toBe('@src/');
  await input.fill('isolated draft');
  await h.page.reload();
  await expect.poll(() => value(input)).toBe('isolated draft');
  const other = await h.conversation('other');
  await h.open(other);
  expect(await value(input)).toBe('');
  await h.open(id);
  await expect.poll(() => value(input)).toBe('isolated draft');
}, 60_000);

test('prompt history reaches every loaded prompt instead of truncating the parent conversation', async () => {
  const h = await harness();
  const id = await h.conversation('p0');
  for (let index = 1; index < 120; index++) {
    expect((await h.page.request.post(`${h.server.url}/api/conversations/${id}/messages`, { data: { text: `p${index}`, requestId: crypto.randomUUID() } })).ok()).toBe(true);
  }
  const input = await h.open(id);
  // A 120-record conversation currently fits the initial snapshot. Older pages
  // are relevant only when the public history projection offers one.
  if (await h.page.getByTestId('load-older').count()) await h.page.getByTestId('load-older').click();
  await expect.poll(() => h.page.getByTestId('message-user').count()).toBe(120);
  for (let index = 119; index >= 0; index--) {
    await input.press('ArrowUp');
    await expect.poll(() => value(input)).toBe(`p${index}`);
  }
  await input.press('ArrowUp');
  expect(await value(input)).toBe('p0');
}, 120_000);

test('attachment upload keeps accepted bytes, removes individual chips and strips local previews from both entry points', async () => {
  const h = await harness();
  const id = await h.conversation();
  const input = await h.open(id);
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nT8AAAAASUVORK5CYII=', 'base64');
  const upload = h.page.getByTestId('chat-attachment-input');
  await upload.setInputFiles([
    { name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') },
    { name: 'pixel.png', mimeType: 'image/png', buffer: image },
  ]);
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(2);
  await expect.poll(() => h.page.locator('.composer-attachment-preview').evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);
  await h.page.getByRole('button', { name: '移除附件 notes.md' }).click();
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(1);
  await upload.setInputFiles({ name: 'notes.md', mimeType: 'text/markdown', buffer: Buffer.from('# Notes\n') });
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(2);
  await input.fill('Read these');
  const sent = h.page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/conversations/${id}/messages`));
  await h.page.getByTestId('chat-send').click();
  expect((await sent).postDataJSON().attachments).toEqual([
    { name: 'pixel.png', type: 'image/png', size: image.length, text: '', data: image.toString('base64') },
    { name: 'notes.md', type: 'text/markdown', size: 8, text: '# Notes\n' },
  ]);
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(0);
  await h.page.reload();
  await expect.poll(() => value(input)).toBe('');
  await expect.poll(() => h.page.locator('.message-attachment-image').last().evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(1);

  await h.page.goto(h.server.url);
  const fresh = h.page.getByTestId('new-conversation-input');
  await fresh.fill('Fresh attachments');
  await h.page.getByTestId('new-conversation-attachment-input').setInputFiles({ name: 'pixel.png', mimeType: 'image/png', buffer: image });
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(1);
  const created = h.page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/api/conversations'));
  await fresh.press('Enter');
  expect((await created).postDataJSON().attachments).toEqual([{ name: 'pixel.png', type: 'image/png', size: image.length, text: '', data: image.toString('base64') }]);
}, 60_000);

test('attachments reject unsupported, binary, oversized, duplicate and excess files with per-file reasons', async () => {
  const h = await harness();
  await h.open(await h.conversation());
  const upload = h.page.getByTestId('chat-attachment-input');
  const notices = h.page.getByTestId('composer-attachment-notices');
  const rejected = [
    { name: 'document.pdf', mimeType: 'application/pdf', buffer: Buffer.from('pdf'), reason: '不支持的文件类型' },
    { name: 'document.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('docx'), reason: '不支持的文件类型' },
    { name: 'image.bmp', mimeType: 'image/bmp', buffer: Buffer.from('bmp'), reason: '不支持的图片格式' },
    { name: 'image.tiff', mimeType: 'image/tiff', buffer: Buffer.from('tiff'), reason: '不支持的图片格式' },
    { name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from('a\0b'), reason: '不是文本文件' },
    { name: 'empty.png', mimeType: 'image/png', buffer: Buffer.alloc(0), reason: '无法读取图片' },
    { name: 'large.png', mimeType: 'image/png', buffer: Buffer.alloc(5 * 1024 * 1024 + 1), reason: '5MB' },
    { name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1), reason: '1MB' },
  ];
  for (const item of rejected) {
    await upload.setInputFiles({ name: item.name, mimeType: item.mimeType, buffer: item.buffer });
    await expect.poll(() => notices.innerText()).toContain(`${item.name}：`);
    expect(await notices.innerText()).toContain(item.reason);
    expect(await h.page.locator('.composer-attachment').count()).toBe(0);
  }
  const half = 4 * 1024 * 1024 + 1;
  await upload.setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: Buffer.alloc(half, 65) },
    { name: 'second.png', mimeType: 'image/png', buffer: Buffer.alloc(half, 66) },
  ]);
  await expect.poll(() => notices.innerText()).toContain('second.png：单条消息的图片总量超过 8MB');
  expect(await notices.innerText()).not.toContain('first.png');
  await h.page.getByRole('button', { name: '移除附件 first.png' }).click();
  await upload.setInputFiles({ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
  await expect.poll(() => notices.count()).toBe(0);
  await upload.setInputFiles({ name: 'small.txt', mimeType: 'text/plain', buffer: Buffer.from('abc') });
  await expect.poll(() => notices.innerText()).toContain('small.txt：已添加同名文件');
  for (let index = 0; index < 4; index++) {
    await upload.setInputFiles({ name: `extra${index}.txt`, mimeType: 'text/plain', buffer: Buffer.from('text') });
    await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(index + 2);
  }
  await upload.setInputFiles({ name: 'sixth.txt', mimeType: 'text/plain', buffer: Buffer.from('sixth') });
  await expect.poll(() => notices.innerText()).toContain('sixth.txt：一条消息最多附加 5 个文件');
}, 90_000);

test('attachment types and sizes are classified through the file picker and actual outgoing payload', async () => {
  const h = await harness();
  const id = await h.conversation();
  await h.open(id);
  const upload = h.page.getByTestId('chat-attachment-input');
  const accepted = [
    { name: 'raster.png', mimeType: 'image/png', type: 'image/png', kind: 'image' },
    { name: 'raster.jpg', mimeType: 'image/jpeg', type: 'image/jpeg', kind: 'image' },
    { name: 'raster.webp', mimeType: 'image/webp', type: 'image/webp', kind: 'image' },
    { name: 'raster.gif', mimeType: 'image/gif', type: 'image/gif', kind: 'image' },
    { name: 'raster.PNG', mimeType: '', type: 'image/png', kind: 'image' },
    { name: 'raster.JPG', mimeType: '', type: 'image/jpeg', kind: 'image' },
    { name: 'parameters.png', mimeType: 'image/png; charset=binary', type: 'image/png', kind: 'image' },
    { name: 'raster.jpeg', mimeType: 'application/octet-stream', type: 'image/jpeg', kind: 'image' },
    ...['readme.md', 'notes.txt', 'data.csv', 'config.json', 'main.ts', 'app.py', 'query.sql'].map(name => ({ name, mimeType: 'application/octet-stream', type: 'application/octet-stream', kind: 'text' })),
    { name: 'noextension', mimeType: 'text/plain', type: 'text/plain', kind: 'text' },
    { name: 'data', mimeType: 'application/json', type: 'application/json', kind: 'text' },
    { name: 'vector.svg', mimeType: 'image/svg+xml', type: 'image/svg+xml', kind: 'text' },
  ];
  for (const item of accepted) {
    const bytes = Buffer.from('fixture');
    await upload.setInputFiles({ name: item.name, mimeType: item.mimeType, buffer: bytes });
    const chip = h.page.locator('.composer-attachment');
    await expect.poll(() => chip.count()).toBe(1);
    expect(await chip.getAttribute('data-kind')).toBe(item.kind);
    expect(await chip.innerText()).toContain('7 B');
    const sent = h.page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith(`/api/conversations/${id}/messages`));
    await h.page.getByTestId('chat-send').click();
    expect((await sent).postDataJSON().attachments).toEqual([{ name: item.name, type: item.type, size: 7,
      ...(item.kind === 'image' ? { text: '', data: bytes.toString('base64') } : { text: 'fixture' }) }]);
    await expect.poll(() => chip.count()).toBe(0);
    const message = h.page.getByTestId('message-user').last();
    await expect.poll(() => message.innerText()).toContain(item.name);
    expect(await message.getByTestId('message-copy').count()).toBe(0);
  }
  await upload.setInputFiles([
    { name: 'kilobytes.txt', mimeType: 'text/plain', buffer: Buffer.alloc(2048, 65) },
    { name: 'megabytes.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024, 65) },
  ]);
  await expect.poll(() => h.page.locator('.composer-attachment').count()).toBe(2);
  expect(await h.page.locator('.composer-attachment').allTextContents()).toEqual(expect.arrayContaining([expect.stringContaining('2.0 KB'), expect.stringContaining('2.0 MB')]));
  await h.page.getByTestId('chat-input').fill('draft without attachment persistence');
  await h.page.reload();
  await expect.poll(() => value(h.page.getByTestId('chat-input'))).toBe('draft without attachment persistence');
  expect(await h.page.locator('.composer-attachment').count()).toBe(0);
}, 90_000);

test('a real failed model turn exposes a system notice without a copy action', async () => {
  const h = await harness([{ status: 401, error: 'The provider rejected the credential', errorCode: 'invalid_api_key' }]);
  await h.open(await h.conversation('A turn that fails before answering'));
  const notice = h.page.getByTestId('message-system');
  await notice.waitFor();
  expect(await notice.getByTestId('message-copy').count()).toBe(0);
  expect(await h.page.getByTestId('message-assistant').count()).toBe(0);
}, 60_000);


test('an empty new-conversation history preserves native multiline arrow movement', async () => {
  const h = await harness();
  await h.page.goto(h.server.url);
  const input = h.page.getByTestId('new-conversation-input');
  await input.fill('first line\nsecond line');
  await selection(input, 0);
  await input.press('ArrowDown');
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(11);
  expect(await value(input)).toBe('first line\nsecond line');
  await input.press('ArrowUp');
  await expect.poll(() => input.evaluate((element: HTMLTextAreaElement) => element.selectionStart)).toBe(0);
  expect(await value(input)).toBe('first line\nsecond line');
  expect(await h.page.locator('[role="listbox"]:visible').count()).toBe(0);
}, 60_000);


test('an actual application delta row stays uncopyable until its original final events and snapshot are delivered', async () => {
  const markdown = '# Actual raw stream\n\nThe application emitted these source bytes.';
  let releaseModel!: () => void; const model = new Promise<void>(resolve => { releaseModel = resolve; });
  let releaseFinal!: () => void; const final = new Promise<void>(resolve => { releaseFinal = resolve; });
  let deliveredDelta!: () => void; const delta = new Promise<void>(resolve => { deliveredDelta = resolve; });
  const h = await harness([{ chunks: ['# Actual raw stream\n\n', 'The application emitted these source bytes.'], beforeReply: () => model }], { final, delta: deliveredDelta });
  cleanup.push(async () => { releaseModel(); releaseFinal(); });
  const id = await h.conversation('Stream a genuine answer');
  await h.open(id);
  await expect.poll(() => h.page.getByTestId('conversation-connection').innerText()).toBe('已连接');
  releaseModel(); await delta;
  const row = h.page.getByTestId('streaming');
  await expect.poll(() => row.count()).toBe(1);
  await expect.poll(() => row.textContent()).toContain('Actual raw stream');
  expect(await row.getByTestId('message-copy').count()).toBe(0);
  expect(await h.page.getByTestId('message-assistant').count()).toBe(0);
  releaseFinal();
  const answer = h.page.getByTestId('message-assistant');
  await expect.poll(() => answer.getByTestId('message-copy').count(), { timeout: 30_000 }).toBe(1);
  await answer.getByTestId('message-copy').click();
  await expect.poll(() => h.page.evaluate(() => navigator.clipboard.readText())).toBe(markdown);
  expect(h.provider!.requests).toHaveLength(1);
}, 90_000);
