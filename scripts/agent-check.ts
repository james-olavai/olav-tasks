// Run: npx tsx scripts/agent-check.ts — drives the agent API with a fake Turn (no network, no credentials).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { caps, roleAgents, type Turn } from '../src/agent.js';

// hard caps and settings sources come from the environment; invalid values are ignored, unset means unlimited / SDK default
assert.deepEqual(caps(), {});
process.env.OLAV_TASKS_MAX_BUDGET_USD = '1.5'; process.env.OLAV_TASKS_MAX_TURNS = 'abc'; process.env.OLAV_TASKS_SETTING_SOURCES = 'project,bogus';
assert.deepEqual(caps(), { maxBudgetUsd: 1.5, settingSources: ['project'] });
process.env.OLAV_TASKS_SETTING_SOURCES = 'none'; assert.deepEqual(caps().settingSources, []);
for (const name of ['OLAV_TASKS_MAX_BUDGET_USD', 'OLAV_TASKS_MAX_TURNS', 'OLAV_TASKS_SETTING_SOURCES']) delete process.env[name];
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
const systems: (string | undefined)[] = [];
const turn: Turn = async function* ({ prompt, cwd, model, systemPrompt, resume, canUseTool }) {
  systems.push(systemPrompt); prompts.push(prompt); cwds.push(cwd); models.push(model);
  if (!resume) await writeFile(join(cwd, 'out.txt'), 'hello\n');
  yield { type: 'system', session_id: 's1' };
  if (!resume) {
    yield { type: 'assistant', message: { model: 'claude-main', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'explorer' } }] } };
    yield { type: 'assistant', parent_tool_use_id: 'tu1', message: { model: 'claude-haiku', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'x' } }] } };
  }
  if (!resume) {
    const allowed = await canUseTool('Bash', { command: 'ls' });
    yield { type: 'assistant', message: { content: [{ type: 'text', text: allowed ? 'allowed' : 'denied' }] } };
  } else yield { type: 'assistant', message: { content: [{ type: 'text', text: `resumed ${resume}` }] } };
  yield { type: 'result', result: 'ok', reported: { cost_usd: resume ? 0.8 : 0.5, input: 100, output: 10, cache_read: 50, cache_write: 5, cumulative: true } };
};
const codexRuns: string[] = [];
const codexFake: Turn = async function* ({ prompt, cwd }) { codexRuns.push(cwd); yield { type: 'assistant', message: { content: [{ type: 'text', text: 'codex did ' + prompt.slice(0, 5) }] } }; yield { type: 'result', result: 'ok', reported: { input: 7, output: 3, cache_read: 2, cache_write: 0, cumulative: false } }; };
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
await until(async () => systems.length > 0);
assert.match(systems[0] ?? '', /Loop development/); assert.match(systems[0] ?? '', /never edit the task file's status/); assert.match(systems[0] ?? '', /prior art/i);
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
assert.deepEqual((await call('/api/agent/runs')).data.runs.map(({ usage, ...rest }: any) => rest), [{ taskId: 'T-1', agent: 'claude', status: 'idle', branch: 'agent/T-1' }]);
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
// usage: Claude totals are cumulative (latest wins, never summed); Codex has no cost, so cost stays unknown rather than 0
const claudeUsage = (await call('/api/agent/run?task=T-1')).data.usage;
assert.equal(claudeUsage.cost_usd, 0.8); assert.equal(claudeUsage.input, 100); assert.equal(claudeUsage.turns, 3);
// accept: only a human action sets done
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: in-progress/);
assert.equal((await call('/api/agent/accept', { task: 'T-1' })).data.accepted, true);
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: done/);
assert.equal((await fetch(base + '/api/agent/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403); // no Origin
// subagent roles: pinned tiers and tools, overridable; events from a subagent are attributed to its role and model
assert.deepEqual(Object.keys(roleAgents()), ['explorer', 'implementer', 'reviewer']);
assert.equal(roleAgents().explorer.model, 'haiku'); assert.deepEqual(roleAgents().explorer.tools, ['Read', 'Grep', 'Glob']);
process.env.OLAV_TASKS_ROLE_MODELS = '{"reviewer":"model-r"}'; assert.equal(roleAgents().reviewer.model, 'model-r'); assert.equal(roleAgents().implementer.model, 'sonnet'); delete process.env.OLAV_TASKS_ROLE_MODELS;
const roleEvents = (await call('/api/agent/run?task=T-1')).data.events;
assert.ok(roleEvents.some((e: any) => e.role === 'explorer' && e.model === 'claude-haiku' && e.text.startsWith('Read')));
assert.ok(roleEvents.some((e: any) => !e.role && e.model === 'claude-main'));
assert.match(systems[0] ?? '', /explorer/);
// default tier mapping for Claude when the user has not configured one for that tier
assert.equal((await call('/api/task-meta', { path: 'T-2.md', field: 'model_profile', value: 'fast', version: (await call('/api/tasks')).data.tasks.find((t: any) => t.id === 'T-2').version }, 'PATCH')).status, 200);
// cleanup: only after acceptance; the work survives on the branch, the worktree directory is gone, and the run cannot be resumed
const worktree = cwds[0];
assert.equal((await call('/api/agent/cleanup', { task: 'T-1' })).data.cleaned, true);
await assert.rejects(readFile(join(worktree, 'out.txt'), 'utf8'));
assert.equal(git('show', 'agent/T-1:out.txt').toString(), 'hello\n');
assert.match((await call('/api/agent/diff?task=T-1')).data.patch, /\+hello/);
assert.equal((await call('/api/agent/send', { task: 'T-1', text: 'x' })).status, 409);
assert.equal((await call('/api/agent/cleanup', { task: 'T-1' })).status, 409); // already cleaned
// dependency-aware dispatch: T-2/T-3 unlock once T-1 is done; T-4 depends on a missing task and never becomes ready
assert.deepEqual((await call('/api/agent/ready')).data.ready.map((t: any) => t.id), ['T-2', 'T-3']);
const batch = (await call('/api/agent/start-ready', {})).data;
assert.deepEqual(batch.started, ['T-2']);
await until(async () => models.length >= 4);
assert.equal(models.at(-1), 'haiku');
assert.deepEqual(batch.skipped.map((item: any) => item.id), ['T-3']); // cap of 1 concurrent run
await call('/api/agent/stop', { task: 'T-2' });
// agent choice: unknown agents are rejected; an explicit choice sets the assignee and routes to that adapter
assert.equal((await call('/api/agent/start', { path: 'T-3.md', agent: 'nope' })).status, 400);
assert.equal((await call('/api/agent/start', { path: 'T-3.md', agent: 'codex' })).data.agent, 'codex');
await until(async () => (await call('/api/agent/run?task=T-3')).data.status === 'idle');
assert.equal(codexRuns.length, 1);
assert.equal((await call('/api/agent/cleanup', { task: 'T-3' })).status, 409); // not accepted yet
const codexUsage = (await call('/api/agent/run?task=T-3')).data.usage;
assert.equal(codexUsage.input, 7); assert.equal(codexUsage.cost_usd, undefined); assert.notEqual(codexRuns[0], root);
assert.match(await readFile(join(root, 'T-3.md'), 'utf8'), /assignee: agent:codex/);
assert.ok((await call('/api/agent/run?task=T-3')).data.events.some((e: any) => e.text.startsWith('codex did')));
server.close();
console.log('agent-check ok');
