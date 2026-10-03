import { createServer, type ServerResponse, type IncomingMessage } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { networkInterfaces } from 'node:os';
import { ApiError, ProjectFiles } from './project-files.js';
import { AgentRuns, type Turn } from './agent.js';

type Project = { root: string; name: string; version: string; port: number; host?: '127.0.0.1' | '0.0.0.0' };
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}
// Agents run code with the host's logins. By default LAN clients may use them (the page is meant to be shared on the LAN);
// OLAV_TASKS_AGENT_LAN=0 restricts them to the machine running the server. YOLO (all permission checks bypassed) is stricter:
// only the host machine, unless OLAV_TASKS_ALLOW_LAN_YOLO=1, because on an unauthenticated LAN page it is remote code execution.
export function isLocalClient(address?: string) {
  const ip = (address ?? '').replace(/^::ffff:/, '');
  return ip === '127.0.0.1' || ip === '::1' || localIPv4Addresses().includes(ip);
}
export const agentAllowed = (address?: string) => process.env.OLAV_TASKS_AGENT_LAN !== '0' || isLocalClient(address);
export const yoloAllowed = (address?: string) => isLocalClient(address) || process.env.OLAV_TASKS_ALLOW_LAN_YOLO === '1';
export function localIPv4Addresses() {
  return [...new Set(Object.values(networkInterfaces()).flatMap(entries => (entries ?? []).filter(entry => entry.family === 'IPv4').map(entry => entry.address)))].sort();
}
function sameOrigin(value: string, authority: string) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.origin === value && value === `http://${authority}`;
  } catch { return false; }
}
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
async function requestBody(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') throw new ApiError(415, 'Writes require Content-Type: application/json.');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    const body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += body.length;
    if (size > 10 * 1024 * 1024) throw new ApiError(413, 'Request body exceeds the 10 MiB limit.');
    chunks.push(body);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, 'Request body must be a JSON object.'); }
}
export async function startServer(project: Project, options: { turns?: Record<string, Turn> } = {}) {
  const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'web');
  // tsx dev runs src/cli.ts; only that mode permits the Vite development origin.
  const development = fileURLToPath(import.meta.url).endsWith('.ts');
  const devPort = Number(process.env.OLAV_TASKS_WEB_PORT ?? '4317');
  const host = project.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Host must be 127.0.0.1 or 0.0.0.0.');
  const hosts = new Set(['127.0.0.1', 'localhost', '[::1]', ...(host === '0.0.0.0' ? ['0.0.0.0', ...localIPv4Addresses()] : [])]);
  const authorities = new Set([...hosts].map(address => `${address}:${project.port}`));
  const devAuthorities = ['127.0.0.1', 'localhost', '[::1]'].map(address => `${address}:${devPort}`);
  const files = new ProjectFiles(project.root);
  const agents = new AgentRuns(files, project.root, options.turns);
  const agentApi = (request: IncomingMessage) => { if (!agentAllowed(request.socket.remoteAddress)) throw new ApiError(403, 'Agents can only be used from the machine running Olav Tasks.'); return agents; };
  const yolo = (request: IncomingMessage, value: unknown) => {
    if (value !== true) return false;
    if (!yoloAllowed(request.socket.remoteAddress)) throw new ApiError(403, 'YOLO mode is only available from the machine running Olav Tasks.');
    return true;
  };
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (!req.headers.host || !authorities.has(req.headers.host) ||
        (req.headers.origin && !(sameOrigin(req.headers.origin, req.headers.host) || (development && devAuthorities.some(authority => sameOrigin(req.headers.origin!, authority)))))) {
        json(res, 403, { error: 'Only requests to an allowed host from this application origin are allowed.' }); return;
      }
      let pathname: string;
      try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0]); }
      catch { json(res, 400, { error: 'Invalid URL encoding.' }); return; }
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').includes('..')) {
        json(res, 400, { error: 'Invalid path.' }); return;
      }
      const readMethod = req.method === 'GET' || req.method === 'HEAD';
      if (pathname.startsWith('/api/')) {
        const url = new URL(req.url ?? '/', `http://127.0.0.1:${project.port}`);
        const path = url.searchParams.get('path');
        if (readMethod) {
          if (pathname === '/api/health') { json(res, 200, { ok: true }); return; }
          if (pathname === '/api/project') { json(res, 200, { name: project.name, root: project.root, version: project.version }); return; }
          if (pathname === '/api/tree') { const scan = await files.scan(); json(res, 200, { entries: scan.entries, truncated: scan.truncated, diagnostics: scan.diagnostics }); return; }
          if (pathname === '/api/tasks') { json(res, 200, await files.tasks()); return; }
          if (pathname === '/api/file') { json(res, 200, await files.read(path)); return; }
          if (pathname === '/api/agent/runs') { const allowed = agentAllowed(req.socket.remoteAddress); json(res, 200, { enabled: allowed, yolo: allowed && yoloAllowed(req.socket.remoteAddress), runs: allowed ? agents.list() : [] }); return; }
          if (pathname === '/api/agent/run') { json(res, 200, agentApi(req).get(url.searchParams.get('task') ?? '', Number(url.searchParams.get('since') ?? 0) || 0)); return; }
          if (pathname === '/api/agent/diff') { json(res, 200, await agentApi(req).diff(url.searchParams.get('task'))); return; }
          if (pathname === '/api/revision') { json(res, 200, { revision: (await files.scan()).revision }); return; }
          if (pathname === '/api/asset') {
            const asset = await files.asset(path);
            res.writeHead(200, { 'Content-Type': asset.type, 'Content-Length': asset.body.length, 'Cache-Control': 'no-cache', 'Content-Security-Policy': "default-src 'none'; sandbox" });
            res.end(req.method === 'HEAD' ? undefined : asset.body); return;
          }
        } else {
          if (!req.headers.origin) throw new ApiError(403, "Writes require this application's local Origin.");
          if (!['POST', 'PATCH', 'DELETE'].includes(req.method ?? '')) throw new ApiError(405, 'Method not allowed.');
          const body = await requestBody(req);
          if (pathname === '/api/agent/chat' && req.method === 'POST') { json(res, 200, agentApi(req).chat(body.agent, body.text, yolo(req, body.yolo))); return; }
          if (pathname === '/api/agent/send' && req.method === 'POST') { json(res, 200, agentApi(req).send(body.task, body.text, yolo(req, body.yolo))); return; }
          if (pathname === '/api/agent/permission' && req.method === 'POST') { json(res, 200, agentApi(req).permission(body.task, body.id, body.allow)); return; }
          if (pathname === '/api/agent/accept' && req.method === 'POST') { json(res, 200, await agentApi(req).accept(body.task)); return; }
          if (pathname === '/api/agent/cleanup' && req.method === 'POST') { json(res, 200, await agentApi(req).cleanup(body.task)); return; }
          if (pathname === '/api/agent/recheck' && req.method === 'POST') { json(res, 200, await agentApi(req).recheck(body.task)); return; }
          if (pathname === '/api/agent/stop' && req.method === 'POST') { json(res, 200, agentApi(req).stop(body.task)); return; }
          if (pathname === '/api/file' && req.method === 'POST') { json(res, 200, await files.save(body.path, body.content, body.version)); return; }
          if (pathname === '/api/file' && req.method === 'DELETE') { json(res, 200, await files.remove(body.path, body.version)); return; }
          if (pathname === '/api/task' && req.method === 'PATCH') { json(res, 200, await files.updateStatus(body.path, body.status, body.version)); return; }
          if (pathname === '/api/task-meta' && req.method === 'PATCH') {
            if (body.field !== 'assignee' && body.field !== 'model_profile') throw new ApiError(400, 'field must be assignee or model_profile.');
            json(res, 200, await files.setMeta(body.path, body.field, body.value, body.version)); return;
          }
          if (pathname === '/api/directory' && req.method === 'POST') { json(res, 200, await files.directory(body.path)); return; }
          if (pathname === '/api/move' && req.method === 'POST') { json(res, 200, await files.move(body.path, body.to, body.version)); return; }
          throw new ApiError(405, 'Method not allowed for this endpoint.');
        }
        json(res, 404, { error: 'API endpoint not found.' }); return;
      }
      if (!readMethod) { res.setHeader('Allow', 'GET, HEAD'); throw new ApiError(405, 'Method not allowed.'); }
      const candidate = resolve(webRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!inside(webRoot, candidate)) { json(res, 403, { error: 'Path is outside the application.' }); return; }
      let file: string;
      try {
        file = await realpath(candidate);
        const actualRoot = await realpath(webRoot);
        if (!inside(actualRoot, file)) { json(res, 403, { error: 'Path is outside the application.' }); return; }
        if (!(await stat(file)).isFile()) { json(res, 404, { error: 'Resource not found.' }); return; }
      } catch { json(res, 404, { error: 'Resource not found. Run npm run build before starting the production server.' }); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : body);
    })().catch((error: unknown) => {
      if (!res.headersSent) json(res, error instanceof ApiError ? error.status : 500, { error: error instanceof ApiError ? error.message : 'Unable to serve the request.' }); else res.end();
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(project.port, host, () => { server.removeListener('error', reject); resolveListen(); });
  });
  return server;
}
