// Run: npx tsx scripts/agent-check.ts — drives the agent API with a fake Turn (no network, no credentials).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import type { Turn } from '../src/agent.js';

const parent = await mkdtemp(join(tmpdir(), 'agent-check-'));
process.env.OLAV_TASKS_MAX_RUNS = '1';
process.env.OLAV_TASKS_MODELS = JSON.stringify({ claude: { deep: 'model-deep' } });
const root = join(parent, 'proj');
execFileSync('mkdir', [root]);
await writeFile(join(root, 'T-1.md'), '---\nschema: olav.tasks/v1\nid: T-1\ntitle: Demo\nstatus: todo\n---\n\nDo the thing.\n');
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
git('init', '-q');
await writeFile(join(root, 'T-2.md'), '---\nschema: olav.tasks/v1\nid: T-2\ntitle: Second\nstatus: todo\ndepends_on: [T-1]\n---\n\nNeeds T-1.\n');
await writeFile(join(root, 'T-3.md'), '---\nschema: olav.tasks/v1\nid: T-3\ntitle: Third\nstatus: todo\ndepends_on: [T-1]\n---\n\nAlso needs T-1.\n');
await writeFile(join(root, 'T-4.md'), '---\nschema: olav.tasks/v1\nid: T-4\ntitle: Fourth\nstatus: todo\ndepends_on: [T-9]\n---\n\nMissing dependency.\n');
git('add', '-A'); git('commit', '-qm', 'init');
const prompts: string[] = [];
const cwds: string[] = [];
const models: (string | undefined)[] = [];
const turn: Turn = async function* ({ prompt, cwd, model, resume, canUseTool }) {
  prompts.push(prompt); cwds.push(cwd); models.push(model);
  if (!resume) await writeFile(join(cwd, 'out.txt'), 'hello\n');
  yield { type: 'system', session_id: 's1' };
  if (!resume) {
    const allowed = await canUseTool('Bash', { command: 'ls' });
    yield { type: 'assistant', message: { content: [{ type: 'text', text: allowed ? 'allowed' : 'denied' }] } };
  } else yield { type: 'assistant', message: { content: [{ type: 'text', text: `resumed ${resume}` }] } };
  yield { type: 'result', result: 'ok' };
};
const codexRuns: string[] = [];
const codexFake: Turn = async function* ({ prompt, cwd }) { codexRuns.push(cwd); yield { type: 'assistant', message: { content: [{ type: 'text', text: 'codex did ' + prompt.slice(0, 5) }] } }; yield { type: 'result', result: 'ok' }; };
let port = 4900 + Math.floor(Math.random() * 90);
let server = await startServer({ root, name: 't', version: '0', port }, { turns: { claude: turn, codex: codexFake } });
let base = `http://127.0.0.1:${port}`;
const call = async (path: string, body?: unknown, method = 'POST') => {
  const res = await fetch(base + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
};
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 50; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };

// meta edit: unknown fields and bad enums are rejected, good ones keep the rest of the file intact
const version = async () => (await call('/api/tasks')).data.tasks[0].version;
assert.equal((await call('/api/task-meta', { path: 'T-1.md', field: 'status', value: 'done', version: await version() }, 'PATCH')).status, 400);
assert.equal((await call('/api/task-meta', { path: 'T-1.md', field: 'model_profile', value: 'huge', version: await version() }, 'PATCH')).status, 400);
assert.equal((await call('/api/task-meta', { path: 'T-1.md', field: 'model_profile', value: 'deep', version: await version() }, 'PATCH')).status, 200);
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /^---\nschema: olav.tasks\/v1\nid: T-1\ntitle: Demo\nstatus: todo\nmodel_profile: deep\n---\n\nDo the thing\.\n$/);
git('add', '-A'); git('commit', '-qm', 'meta');
assert.equal((await call('/api/agent/start', { path: 'T-1.md' })).status, 200);
assert.equal(models[0], 'model-deep');
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /assignee: agent:claude/);
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
assert.deepEqual((await call('/api/agent/runs')).data.runs, [{ taskId: 'T-1', agent: 'claude', status: 'idle', branch: 'agent/T-1' }]);
// worktree isolation: agent wrote out.txt in its own worktree, not in the project root
assert.notEqual(cwds[0], root);
await assert.rejects(readFile(join(root, 'out.txt'), 'utf8'));
const diff = (await call('/api/agent/diff?task=T-1')).data;
assert.equal(diff.branch, 'agent/T-1');
assert.match(diff.patch, /\+hello/);
// persistence: a fresh server instance restores the run and can resume by sessionId
server.close();
port += 100; base = `http://127.0.0.1:${port}`;
server = await startServer({ root, name: 't', version: '0', port }, { turns: { claude: turn, codex: codexFake } });
const restored = (await call('/api/agent/run?task=T-1')).data;
assert.equal(restored.status, 'idle'); assert.ok(restored.events.length > 3);
await call('/api/agent/send', { task: 'T-1', text: 'again' });
await until(async () => (await call('/api/agent/run?task=T-1')).data.status === 'idle' && prompts.at(-1) === 'again');
// accept: only a human action sets done
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: in-progress/);
assert.equal((await call('/api/agent/accept', { task: 'T-1' })).data.accepted, true);
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: done/);
assert.equal((await fetch(base + '/api/agent/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403); // no Origin
// dependency-aware dispatch: T-2/T-3 unlock once T-1 is done; T-4 depends on a missing task and never becomes ready
assert.deepEqual((await call('/api/agent/ready')).data.ready.map((t: any) => t.id), ['T-2', 'T-3']);
const batch = (await call('/api/agent/start-ready', {})).data;
assert.deepEqual(batch.started, ['T-2']);
assert.deepEqual(batch.skipped.map((item: any) => item.id), ['T-3']); // cap of 1 concurrent run
await call('/api/agent/stop', { task: 'T-2' });
// agent choice: unknown agents are rejected; an explicit choice sets the assignee and routes to that adapter
assert.equal((await call('/api/agent/start', { path: 'T-3.md', agent: 'nope' })).status, 400);
assert.equal((await call('/api/agent/start', { path: 'T-3.md', agent: 'codex' })).data.agent, 'codex');
await until(async () => (await call('/api/agent/run?task=T-3')).data.status === 'idle');
assert.equal(codexRuns.length, 1); assert.notEqual(codexRuns[0], root);
assert.match(await readFile(join(root, 'T-3.md'), 'utf8'), /assignee: agent:codex/);
assert.ok((await call('/api/agent/run?task=T-3')).data.events.some((e: any) => e.text.startsWith('codex did')));
server.close();
console.log('agent-check ok');
