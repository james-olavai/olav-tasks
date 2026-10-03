// Run: npx tsx scripts/agent-check.ts — drives the agent API with a fake Turn (no network, no credentials).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import type { Turn } from '../src/agent.js';

const root = await mkdtemp(join(tmpdir(), 'agent-check-'));
await writeFile(join(root, 'T-1.md'), '---\nschema: olav.tasks/v1\nid: T-1\ntitle: Demo\nstatus: todo\n---\n\nDo the thing.\n');
const prompts: string[] = [];
const turn: Turn = async function* ({ prompt, resume, canUseTool }) {
  prompts.push(prompt);
  yield { type: 'system', session_id: 's1' };
  if (!resume) {
    const allowed = await canUseTool('Bash', { command: 'ls' });
    yield { type: 'assistant', message: { content: [{ type: 'text', text: allowed ? 'allowed' : 'denied' }] } };
  } else yield { type: 'assistant', message: { content: [{ type: 'text', text: `resumed ${resume}` }] } };
  yield { type: 'result', result: 'ok' };
};
const port = 4900 + Math.floor(Math.random() * 90);
const server = await startServer({ root, name: 't', version: '0', port }, { turn });
const base = `http://127.0.0.1:${port}`;
const call = async (path: string, body?: unknown) => {
  const res = await fetch(base + path, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
};
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };

assert.equal((await call('/api/agent/start', { path: 'T-1.md' })).status, 200);
assert.match(prompts[0], /Do the thing/);
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: in-progress/);
await until(async () => (await call('/api/agent/run?task=T-1')).data.status === 'blocked');
const blocked = (await call('/api/agent/run?task=T-1')).data;
assert.equal((await call('/api/agent/send', { task: 'T-1', text: 'x' })).status, 409); // no input while blocked
assert.equal((await call('/api/agent/permission', { task: 'T-1', id: 'wrong', allow: true })).status, 409);
await call('/api/agent/permission', { task: 'T-1', id: blocked.pending.id, allow: true });
await until(async () => (await call('/api/agent/run?task=T-1')).data.status === 'idle');
assert.ok((await call('/api/agent/run?task=T-1')).data.events.some((e: any) => e.text === 'allowed'));
await call('/api/agent/send', { task: 'T-1', text: 'more' });
await until(async () => (await call('/api/agent/run?task=T-1&since=3')).data.events.some((e: any) => e.text === 'resumed s1'));
assert.deepEqual((await call('/api/agent/runs')).data.runs, [{ taskId: 'T-1', agent: 'claude', status: 'idle' }]);
assert.equal((await fetch(base + '/api/agent/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403); // no Origin
server.close();
console.log('agent-check ok');
