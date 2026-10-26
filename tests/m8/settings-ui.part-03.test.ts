import { createServer } from 'node:http';

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import type { AddressInfo } from 'node:net';

import { afterAll, afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium, type Page } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';
import { cleanup, webDir, SECRET, openModelEditor, temp, stubProvider, modelListStubProvider, configFile, start, session } from "./settings-ui.fixture.ts";



test('a supported platform offers an editable account name', async () => {
  const dir = await temp('account-name');
  const stub = await stubProvider();
  const path = await configFile(dir, stub.baseUrl, {
    credentials: { 'opencode-go-3': { platform: 'opencode-go', secretRef: 'GRAPH_OPENCODE_GO_ACCOUNT_3', displayName: '账户 2' } },
  });
  const daemon = await start(dir, path);
  const browser = await chromium.launch({ headless: true });
  cleanup.push(() => browser.close());
  const page = await browser.newPage();
  await page.goto(`${daemon.url}/#/models`);
  await page.getByTestId('settings-page').waitFor();
  await openModelEditor(page);

  // The vendor card lives in the independent 模型 tab.
  await page.getByTestId('provider-platform-opencode-go').click();
  const name = page.getByTestId('provider-label');
  await name.waitFor();
  // A supported platform is named by its label, and the operator may rename it.
  expect(await name.inputValue()).toBe('OpenCode Go');
  expect(await name.isEditable()).toBe(true);

  // Switching the credential id to an account shows that account's own name and
  // variable, so an existing account can be renamed instead of silently keeping
  // the platform's credential in the form.
  await page.getByTestId('provider-credentialId').fill('opencode-go-3');
  await expect.poll(async () => page.getByTestId('provider-credentialRef').inputValue(), { timeout: 10_000 }).toBe('GRAPH_OPENCODE_GO_ACCOUNT_3');
  expect(await name.inputValue()).toBe('账户 2');

  // And the operator may overwrite it.
  await name.fill('账户 2 · 工作');
  expect(await name.inputValue()).toBe('账户 2 · 工作');
}, 60_000);
