import { randomUUID } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

const cookieName = 'graph_session';

export function createSession() {
  return randomUUID();
}

export function localOrigin(origin: string | undefined) {
  if (!origin) return;
  try {
    const host = new URL(origin).hostname;
    if (host === '127.0.0.1' || host === 'localhost') return origin;
  } catch { /* invalid origin */ }
}

export function setSessionCookie(reply: FastifyReply, token: string) {
  reply.header('set-cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
}

export function readCookie(request: FastifyRequest, name: string) {
  const header = request.headers.cookie;
  if (!header) return;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
}

export function guard(token: string, request: FastifyRequest) {
  if (readCookie(request, cookieName) !== token) {
    const error = Object.assign(new Error('Authentication required'), { statusCode: 401, code: 'unauthorized' });
    throw error;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD' && !localOrigin(request.headers.origin)) {
    const error = Object.assign(new Error('Local origin required'), { statusCode: 403, code: 'forbidden_origin' });
    throw error;
  }
}
