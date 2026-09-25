import { expect, test } from 'vitest';
import { createSecretPersist } from '../../src/server/secret-persist.ts';

test('an agent write becomes a pending durable write until the desktop confirms it', () => {
  const persist = createSecretPersist();
  persist.mark('GRAPH_PROVIDER_API_KEY', 'sk-agent');
  expect(persist.list()).toEqual([{ ref: 'GRAPH_PROVIDER_API_KEY', value: 'sk-agent' }]);
  // The desktop stored it and says so: nothing is pending any more.
  persist.mark('GRAPH_PROVIDER_API_KEY', 'sk-agent');
  persist.confirmed('GRAPH_PROVIDER_API_KEY');
  expect(persist.list()).toEqual([]);
  expect(persist.refs()).toEqual([]);
});

test('a revocation is a pending delete rather than a pending write', () => {
  const persist = createSecretPersist();
  persist.mark('GRAPH_PROVIDER_API_KEY', null);
  expect(persist.list()).toEqual([{ ref: 'GRAPH_PROVIDER_API_KEY', value: null }]);
});

test('the last write for a ref wins and a keychain-only ref is never pending', () => {
  const persist = createSecretPersist();
  persist.mark('A_KEY', 'first');
  persist.mark('A_KEY', 'second');
  expect(persist.list()).toEqual([{ ref: 'A_KEY', value: 'second' }]);
  // A ref the user saved in the App window is never listed: its value comes from
  // the keychain and must not travel back out of the daemon.
  expect(persist.refs()).not.toContain('GRAPH_SUBSCRIPTION_GROK_ACCESS_TOKEN');
});

test('confirming an unknown ref is harmless', () => {
  const persist = createSecretPersist();
  expect(() => persist.confirmed('NEVER_WRITTEN')).not.toThrow();
  expect(persist.list()).toEqual([]);
});
