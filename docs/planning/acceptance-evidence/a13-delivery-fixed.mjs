// Fixed-behavior probe for the reworked delivery. Synthetic inputs only.
// Exits 0 only when nonzero business codes and captured exceptions reach the
// progress tracker and the final failure summary with code and reason.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('Pass the delivery repository path as the first argument.');
const repository = process.argv[2];
const { runBilibiliWebCollect } = await import(pathToFileURL(resolve(repository, 'src/platforms/bilibili-web.js')).href);

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
assert.equal(failure.summary.fail, 1);
assert.equal(failure.summary.failures['synthetic network failure'], 1);
assert.ok(lines.some((line) => line.includes('synthetic network failure')));
console.log(JSON.stringify({ case: 'throwing-listMedia', pass: true, failures: failure.failures, summary: { fail: failure.summary.fail, failures: failure.summary.failures }, logged: lines }, null, 2));

const apiResponses = [
  { code: 0, data: { list: [{ id: 1, title: 'synthetic-folder' }] } },
  { code: -352, message: 'synthetic rate limit' },
];
const apiLines = [];
const mockPage = {
  async goto() {}, async waitForTimeout() {},
  async evaluate() { return apiResponses.shift(); },
  async close() {},
};
const apiFailure = await runBilibiliWebCollect({ async newPage() { return mockPage; } }, { uid: 'synthetic-user', logger: (line) => apiLines.push(line) });
assert.equal(apiFailure.items.length, 0);
assert.equal(apiFailure.errors.length, 1);
assert.equal(apiFailure.errors[0].code, -352);
assert.match(apiFailure.errors[0].message, /code=-352/);
assert.equal(apiFailure.failureCount, 1);
assert.equal(apiFailure.summary.fail, 1);
assert.ok(apiFailure.incomplete.some((range) => range.code === -352 && range.fromPage === 1));
assert.ok(apiLines.some((line) => line.includes('synthetic rate limit')));
console.log(JSON.stringify({ case: 'nonzero-api-code', pass: true, code: apiFailure.errors[0].code, message: apiFailure.errors[0].message, incomplete: apiFailure.incomplete, summary: { fail: apiFailure.summary.fail, failures: apiFailure.summary.failures }, logged: apiLines }, null, 2));
