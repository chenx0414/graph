import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { build } from 'vite';
import { chromium } from 'playwright';
import {
  MCP_PAYLOAD_SENTINEL, launchToolActivityGraph, openConsole,
} from '../fixtures/tool-activity-graph.ts';

/**
 * The tool rows a person sees in the console.
 *
 * D1/D2 are about the rendered line, so the assertion is the row text in a real
 * browser on the built console, served by the real daemon: an MCP call reads as
 * `服务:命令` instead of the bare tool name, and a computer-use call has its own
 * label and subcommand instead of falling back to `调用`. The rows are located
 * by `data-testid`, and the turn is unfolded through the product's own buttons.
 */

let webDir = '';
beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-tool-activity-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 120_000);

afterAll(async () => { await rm(webDir, { recursive: true, force: true }); });

test('an MCP row names its service and command, and a desktop row names its subcommand', async () => {
  const graph = await launchToolActivityGraph({ webDir });
  const browser = await chromium.launch({ headless: true });
  try {
    const conversationId = await graph.open();
    await graph.settle(conversationId);
    const page = await browser.newPage();
    await page.request.get(graph.daemon.url);
    await openConsole(page, graph.daemon.url, conversationId);

    const conversation = page.locator('[data-testid="conversation"]:visible');
    const rows = conversation.getByTestId('tool-activity-row');
    await expect.poll(() => rows.count()).toBe(2);
    const texts = await rows.allInnerTexts();
    const mcp = texts.find(text => text.includes('MCP')) ?? '';
    const desktop = texts.find(text => text.includes('desktop')) ?? '';

    // D1: 「服务:命令」, not the bare gateway tool name the host used to record.
    expect(mcp, 'the MCP row still reads as the bare tool name').toContain('rea: open_binary');
    expect(mcp).toContain('MCP 调用');
    expect(mcp, 'the MCP arguments were copied into the row').not.toContain(MCP_PAYLOAD_SENTINEL);

    // D2: its own label and the subcommand, not the generic 调用 bucket.
    expect(desktop).toContain('桌面');
    expect(desktop).toContain('snapshot --app Finder');
    expect(desktop).not.toContain('调用 desktop');

    await page.screenshot({ path: '/tmp/graph-tool-activity-labels.png' });
  } finally {
    await browser.close();
    await graph.close();
  }
}, 300_000);
