// The HTTP front door: one node:http server, one ForgeStore, four protocols
// on one router — git smart HTTP, REST v3, GraphQL and MCP — plus /healthz.
// Bodies are read fully into a Buffer (packs here are small; the pack parser
// then works entry by entry, never holding a second whole copy), responses
// are JSON unless a handler hands back raw bytes (git pkt-lines, 204s).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ForgeStore } from './store.ts';
import { handleGraphql } from './graphql.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack, type GitRequest } from './githttp.ts';
import { handleMcp } from './mcp.ts';
import { handleRest, type RestRequest } from './rest.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function headersOf(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key] = Array.isArray(value) ? value[0] : value;
  }
  return out;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, headers?: Record<string, string>): void {
  res.writeHead(status, { 'content-type': contentType, ...headers });
  res.end(body);
}

function authed(req: IncomingMessage): boolean {
  const token = process.env.MAKEFUN_SHOP_TOKEN;
  if (!token) return true;
  return req.headers['authorization'] === `Bearer ${token}`;
}

export function createApp(store = new ForgeStore()): Server {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';
      const headers = headersOf(req);

      // liveness probe, answered before anything else touches the store.
      if (pathname === '/healthz' && method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = needsBody ? await readBody(req) : undefined;

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        if (!authed(req)) {
          sendJson(res, 401, { message: 'Bad credentials' });
          return;
        }
        const [, owner, repo, action] = gitMatch as unknown as [string, string, string, string];
        const serviceParam = url.searchParams.get('service');
        const gitReq: GitRequest = {
          owner: decodeURIComponent(owner!),
          repo: decodeURIComponent(repo!),
          service: serviceParam === 'git-receive-pack' ? 'git-receive-pack' : 'git-upload-pack',
          headers,
          body: body ?? Buffer.alloc(0),
        };
        if (action === 'info/refs' && method === 'GET') {
          if (serviceParam !== 'git-upload-pack' && serviceParam !== 'git-receive-pack') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const result = handleInfoRefs(store, gitReq);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        if (action === 'git-upload-pack' && method === 'POST') {
          const result = handleUploadPack(store, gitReq);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        if (action === 'git-receive-pack' && method === 'POST') {
          const result = handleReceivePack(store, gitReq);
          sendBuffer(res, result.status, result.body, result.contentType);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      // GraphQL.
      if (pathname === '/api/graphql' && method === 'POST') {
        const result = handleGraphql(store, { headers, body });
        sendJson(res, result.status, result.body);
        return;
      }

      // MCP.
      if (pathname === '/mcp' && method === 'POST') {
        const result = handleMcp(store, { headers, body });
        if (Buffer.isBuffer(result.body)) {
          sendBuffer(res, result.status, result.body, 'application/json', result.headers);
        } else {
          sendJson(res, result.status, result.body, result.headers);
        }
        return;
      }

      // REST v3.
      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        const restPath = pathname === '/api/v3' ? '' : pathname.slice('/api/v3/'.length);
        const segments = restPath === '' ? [] : restPath.split('/').map((segment) => decodeURIComponent(segment));
        const host = headers['host'] ?? '127.0.0.1';
        const restReq: RestRequest = {
          method,
          segments,
          query: url.searchParams,
          headers,
          origin: `http://${host}`,
          body,
        };
        const result = handleRest(store, restReq);
        if (result === null) {
          sendJson(res, 404, { message: 'Not Found' }, { 'X-GitHub-Request-Id': store.nextRequestId() });
          return;
        }
        if (Buffer.isBuffer(result.body)) {
          sendBuffer(res, result.status, result.body, 'application/json', result.headers);
        } else {
          sendJson(res, result.status, result.body, result.headers);
        }
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
      } else {
        res.end();
      }
    }
  });
  return server;
}
