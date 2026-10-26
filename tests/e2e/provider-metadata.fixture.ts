import { createServer } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';

import { vendorProxy } from '../helpers/vendor-proxy.ts';
export let webDir: string;

export const cleanup: (() => Promise<void>)[] = [];


beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-e2e-metadata-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);


afterAll(() => rm(webDir, { recursive: true, force: true }));


afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

export const providerMap = { custom: { id: 'custom', models: {
  flagship: { id: 'flagship', reasoning: true, reasoning_options: [{ type: 'effort', values: ['none', 'bogus', 'max'] }], modalities: { input: ['text', 'image', 'pdf'] }, limit: { context: 200_000, output: 32_000 }, cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75, currency: 'EUR' } },
  partial: { id: 'partial', modalities: { input: ['text'] }, limit: { context: 8_000, output: 2_000 }, cost: { input: 2, output: 8 } },
} } };
