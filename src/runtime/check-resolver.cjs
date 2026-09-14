/**
 * Preloaded (via --require) into sandboxed `node` checks.
 *
 * The OS resolver is unreachable inside the sandbox (mDNSResponder), so
 * loopback names resolve locally; every other name falls through to the
 * original lookup and keeps its sandbox outcome.
 */
const dns = require('node:dns');

function loopbackFor(hostname, family) {
  const name = String(hostname).toLowerCase();
  if (name !== 'localhost' && name !== 'ip6-localhost') return undefined;
  return family === 6 ? '::1' : '127.0.0.1';
}

if (!dns.__graphLoopbackResolver) {
  const originalLookup = dns.lookup;
  dns.lookup = function lookup(hostname, options, callback) {
    if (typeof options === 'function') { callback = options; options = {}; }
    const address = loopbackFor(hostname, options && options.family);
    if (address) {
      const family = address.includes(':') ? 6 : 4;
      if (options && options.all) return process.nextTick(callback, null, [{ address, family }]);
      return process.nextTick(callback, null, address, family);
    }
    return originalLookup.call(dns, hostname, options, callback);
  };
  const promises = dns.promises;
  if (promises) {
    const originalPromiseLookup = promises.lookup;
    promises.lookup = async function lookup(hostname, options) {
      const address = loopbackFor(hostname, options && options.family);
      if (!address) return originalPromiseLookup.call(promises, hostname, options);
      const family = address.includes(':') ? 6 : 4;
      if (options && options.all) return [{ address, family }];
      return { address, family };
    };
  }
  dns.__graphLoopbackResolver = true;
}
