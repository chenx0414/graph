import { expect, test } from 'vitest';
import { parseRegistrySearch } from '../../src/runtime/pi-package-search.ts';

const payload = {
  objects: [
    {
      package: {
        name: 'pi-web-access',
        version: '0.31.0',
        description: 'Web search and fetching for Pi',
        keywords: ['pi-package', 'pi', 'extension'],
        publisher: { username: 'nicopreme' },
        links: { npm: 'https://www.npmjs.com/package/pi-web-access' },
      },
      downloads: { weekly: 85225 },
    },
    {
      // Fuzzy search returns packages that are not Pi packages; the keyword decides.
      package: { name: 'some-other-package', version: '1.0.0', description: 'Not a Pi package', keywords: ['pi'], publisher: { username: 'nobody' } },
      downloads: { weekly: 12 },
    },
    {
      package: { name: '@acme/pi-toolkit', version: '2.0.0', keywords: ['pi-package'] },
    },
  ],
  total: 3,
};

test('the official Pi package channel is browsed by its marker keyword', () => {
  expect(parseRegistrySearch(payload)).toEqual([
    {
      name: 'pi-web-access',
      version: '0.31.0',
      description: 'Web search and fetching for Pi',
      publisher: 'nicopreme',
      weeklyDownloads: 85225,
      url: 'https://www.npmjs.com/package/pi-web-access',
    },
    {
      name: '@acme/pi-toolkit',
      version: '2.0.0',
      description: '',
      publisher: null,
      weeklyDownloads: null,
      url: null,
    },
  ]);
  // A payload without the expected shape is empty, never a crash.
  expect(parseRegistrySearch(null)).toEqual([]);
  expect(parseRegistrySearch({ objects: 'nope' })).toEqual([]);
  expect(parseRegistrySearch({ objects: [{ package: { name: '' } }] })).toEqual([]);
});
