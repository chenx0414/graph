package graph

const listenGuardEnv = "GRAPH_LISTEN_GUARD"

const maxWorkerRequestBytes = 32 * 1024 * 1024

const maxWorkerReplyBytes = 32 * 1024 * 1024

const loopbackListenGuard = `'use strict';
// Routing shim only: the sandbox denies every bind and the host owns the only
// loopback listeners. The host binds the exact requested port, duplicates the
// bound socket over the IPC channel and drops its own copy, so the check holds
// the only accepting descriptor. Removing this preload only removes the route;
// it can never grant a bind, and a busy port keeps its original error instead
// of being silently replaced by another one.
if (process.env.GRAPH_LISTEN_GUARD === '1') (function install() {
delete process.env.GRAPH_LISTEN_GUARD;
const net = require('node:net');
const dgram = require('node:dgram');
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
function denied(message) {
  const error = new Error(message || 'EPERM: sandboxed checks may only listen on an explicit loopback host');
  error.code = 'EPERM';
  return error;
}
function deny() { throw denied(); }
function boundedPort(value) {
  return Number.isInteger(value) && value >= 0 && value <= 65535 ? value : undefined;
}
function listenRequest(args) {
  const first = args[0];
  if (first && typeof first === 'object') {
    if (first.path !== undefined || first.fd !== undefined) return undefined;
    const port = boundedPort(first.port === undefined ? 0 : first.port);
    return port === undefined ? undefined : { port, host: typeof first.host === 'string' ? first.host : undefined };
  }
  if (typeof first === 'string') return undefined; // Unix socket paths are not host-provided.
  const port = boundedPort(first === undefined ? 0 : first);
  return port === undefined ? undefined : { port, host: typeof args[1] === 'string' ? args[1] : undefined };
}
function lastCallback(args) {
  const last = args[args.length - 1];
  return typeof last === 'function' ? last : undefined;
}
function hostHandle(value) {
  if (value === null || typeof value !== 'object') return false;
  if (value instanceof net.Server) return true;
  return typeof value.fd === 'number' && typeof value.bind === 'function' &&
    typeof value.listen === 'function' && typeof value.getsockname === 'function';
}
const listen = net.Server.prototype.listen;
const close = net.Server.prototype.close;
const waiting = new Map();
const fireOn = new Map();
const granted = new WeakMap();
const heldListening = new WeakMap();
let nextId = 1;
function holdListening(server) {
  if (heldListening.has(server)) return;
  const original = server.emit;
  const state = { original, patched: null, deferred: null };
  state.patched = function (event, ...args) {
    if (event === 'listening') {
      state.deferred = () => original.call(this, 'listening', ...args);
      return true;
    }
    return original.apply(this, [event, ...args]);
  };
  server.emit = state.patched;
  heldListening.set(server, state);
}
function releaseListening(server, fire) {
  const state = heldListening.get(server);
  if (!state) return;
  heldListening.delete(server);
  if (server.emit === state.patched) server.emit = state.original;
  if (fire && state.deferred) state.deferred();
}
function channelRef() {
  if (process.channel && typeof process.channel.ref === 'function') process.channel.ref();
}
function channelIdle() {
  if (waiting.size === 0 && fireOn.size === 0 && process.channel && typeof process.channel.unref === 'function') process.channel.unref();
}
channelIdle();
net.Server.prototype.listen = function (...args) {
  if (hostHandle(args[0])) return listen.apply(this, args);
  const request = listenRequest(args);
  if (!request || request.host === undefined || !LOOPBACK.has(request.host)) deny();
  if (typeof process.send !== 'function' || process.connected === false) deny();
  const id = nextId++;
  const callback = lastCallback(args);
  if (callback) this.once('listening', callback);
  waiting.set(id, { server: this });
  granted.set(this, id);
  channelRef();
  process.send({ type: 'graph-check-listener', id, port: request.port, host: request.host });
  return this;
};
net.Server.prototype.close = function (...args) {
  const id = granted.get(this);
  if (id !== undefined) {
    granted.delete(this);
    if (waiting.delete(id) || fireOn.delete(id)) { releaseListening(this, false); channelIdle(); }
    if (typeof process.send === 'function' && process.connected !== false) {
      try { process.send({ type: 'graph-check-listener-close', id }); } catch { /* channel closed */ }
    }
  }
  return close.apply(this, args);
};
process.on('message', (message, handle) => {
  if (!message) return;
  if (message.type === 'graph-check-listener-ready') {
    const pending = fireOn.get(message.id);
    if (!pending) { channelIdle(); return; }
    fireOn.delete(message.id);
    releaseListening(pending.server, true);
    channelIdle();
    return;
  }
  if (message.type !== 'graph-check-listener-result') return;
  const entry = waiting.get(message.id);
  if (!entry) {
    if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
    channelIdle();
    return;
  }
  waiting.delete(message.id);
  if (message.ok && handle) {
    holdListening(entry.server);
    fireOn.set(message.id, entry);
    try { listen.call(entry.server, handle); }
    catch (error) {
      fireOn.delete(message.id);
      releaseListening(entry.server, false);
      if (handle && typeof handle.close === 'function') { try { handle.close(); } catch { /* already closed */ } }
      channelIdle();
      process.nextTick(() => { throw error; });
      return;
    }
    if (typeof process.send === 'function' && process.connected !== false) {
      process.send({ type: 'graph-check-listener-adopted', id: message.id });
    } else {
      fireOn.delete(message.id);
      releaseListening(entry.server, true);
      channelIdle();
    }
    channelIdle();
    return;
  }
  const error = new Error(message.message || 'EPERM: the host refused the loopback listener');
  error.code = message.code || 'EPERM';
  channelIdle();
  process.nextTick(() => entry.server.emit('error', error));
});
// No UDP listener is host-provided; the profile denies the bind as well.
dgram.Socket.prototype.bind = function () { deny(); };
})();
`
