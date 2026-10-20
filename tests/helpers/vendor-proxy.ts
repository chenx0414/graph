import { execFileSync } from 'node:child_process';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createTlsServer } from 'node:https';
import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Controlled external vendors over the daemon's real proxy and CA settings.
 * CONNECT is confined to the named vendors; nothing is forwarded online. */
export async function vendorProxy(root: string, hosts: string[], origin: string) {
  const key = join(root, 'vendor.key');
  const cert = join(root, 'vendor.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-keyout', key, '-out', cert,
    '-subj', '/CN=Graph controlled external vendor', '-addext', `subjectAltName=${hosts.map(host => `DNS:${host}`).join(',')}`], { stdio: 'pipe' });
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); };
  const destination = new URL(origin);
  const tls = createTlsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const upstream = httpRequest(new URL(request.url ?? '/', destination), {
      method: request.method, headers: { ...request.headers, host: destination.host },
    }, reply => { response.writeHead(reply.statusCode ?? 502, reply.headers); reply.pipe(response); });
    upstream.on('error', error => response.destroy(error));
    request.on('error', error => upstream.destroy(error));
    request.pipe(upstream);
  });
  tls.on('connection', track);
  await new Promise<void>(resolve => tls.listen(0, '127.0.0.1', resolve));
  const address = tls.address();
  if (!address || typeof address === 'string') throw new Error('Missing controlled vendor TLS port');
  const proxy = createServer((_request, response) => response.writeHead(502).end('CONNECT required'));
  proxy.on('connect', (request, client, head) => {
    const [host, port] = (request.url ?? '').split(':');
    if (!host || !hosts.includes(host) || port !== '443') { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
    const upstream = connect(address.port, '127.0.0.1', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      client.pipe(upstream); upstream.pipe(client);
    });
    track(upstream);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    client.on('close', () => upstream.destroy());
  });
  proxy.on('connection', track);
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const endpoint = proxy.address();
  if (!endpoint || typeof endpoint === 'string') throw new Error('Missing controlled vendor proxy port');
  return { env: { HTTPS_PROXY: `http://127.0.0.1:${endpoint.port}`, HTTP_PROXY: `http://127.0.0.1:${endpoint.port}`,
    NO_PROXY: '127.0.0.1,localhost', NODE_EXTRA_CA_CERTS: cert },
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([new Promise<void>(resolve => proxy.close(() => resolve())), new Promise<void>(resolve => tls.close(() => resolve()))]);
    } };
}
