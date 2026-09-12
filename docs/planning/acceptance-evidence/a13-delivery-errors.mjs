// Offline review probe for delivery commit 725cb1be. All inputs are synthetic.
// No browser, network, project configuration, profile, or real favorites are read.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass the delivery repository path as the first argument.');
const moduleUrl = pathToFileURL(resolve(process.argv[2], 'src/platforms/bilibili-web.js'));
const { runBilibiliWebCollect } = await import(moduleUrl.href);

const lines = [];
const failure = await runBilibiliWebCollect(undefined, {
  uid: 'synthetic-user',
  logger: (line) => lines.push(line),
  client: {
    async listFolders() { return [{ id: 1, title: 'synthetic-folder' }]; },
    async listMedia() { throw new Error('synthetic network failure'); },
  },
});
assert.equal(failure.failures['synthetic network failure'], 1);
assert.equal(failure.summary.fail, 0);
assert.deepEqual(failure.summary.failures, {});
assert.equal(lines.some((line) => line.includes('synthetic network failure')), false);
console.log(JSON.stringify({
  case: 'throwing-listMedia',
  returnedFailures: failure.failures,
  summary: failure.summary,
  logged: lines,
}, null, 2));

const apiResponses = [
  { code: 0, data: { list: [{ id: 1, title: 'synthetic-folder' }] } },
  { code: -352, message: 'synthetic rate limit' },
];
const apiLines = [];
const mockPage = {
  async goto() {},
  async waitForTimeout() {},
  async evaluate() { return apiResponses.shift(); },
  async close() {},
};
const apiFailure = await runBilibiliWebCollect({
  async newPage() { return mockPage; },
}, {
  uid: 'synthetic-user',
  logger: (line) => apiLines.push(line),
});
assert.equal(apiFailure.items.length, 0);
assert.deepEqual(apiFailure.failures, {});
assert.equal(apiFailure.summary.fail, 0);
assert.equal(apiResponses.length, 0);
console.log(JSON.stringify({
  case: 'nonzero-api-code',
  items: apiFailure.items.length,
  failures: apiFailure.failures,
  summary: apiFailure.summary,
  logged: apiLines,
}, null, 2));
