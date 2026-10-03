// Run: npx tsx scripts/agent-check.ts — drives the agent API with fake agents (no network, no credentials).
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { caps, roleAgents, type Turn } from '../src/agent.js';
import { agentAllowed, isLocalClient, localIPv4Addresses, startServer, yoloAllowed } from '../src/server.js';

process.env.ANTHROPIC_API_KEY = 'secret-must-not-reach-checks';
process.env.OLAV_TASKS_EFFORT = '{"claude":"high"}';

// hard caps and settings sources come from the environment; invalid values are ignored, unset means unlimited / SDK default
assert.deepEqual(caps(), {});
process.env.OLAV_TASKS_MAX_BUDGET_USD = '1.5'; process.env.OLAV_TASKS_MAX_TURNS = 'abc'; process.env.OLAV_TASKS_SETTING_SOURCES = 'project,bogus';
assert.deepEqual(caps(), { maxBudgetUsd: 1.5, settingSources: ['project'] });
process.env.OLAV_TASKS_SETTING_SOURCES = 'none'; assert.deepEqual(caps().settingSources, []);
for (const name of ['OLAV_TASKS_MAX_BUDGET_USD', 'OLAV_TASKS_MAX_TURNS', 'OLAV_TASKS_SETTING_SOURCES']) delete process.env[name];
// subagent roles: pinned tiers, medium effort and tools, overridable
assert.deepEqual(Object.keys(roleAgents()), ['explorer', 'researcher', 'implementer', 'reviewer']);
assert.ok(Object.values(roleAgents()).every(role => role.effort === 'medium'));
assert.equal(roleAgents().explorer.model, 'haiku'); assert.deepEqual(roleAgents().explorer.tools, ['Read', 'Grep', 'Glob']);
assert.equal(roleAgents().researcher.model, 'sonnet'); assert.ok(roleAgents().researcher.tools.includes('WebSearch') && !roleAgents().researcher.tools.includes('Bash'));
process.env.OLAV_TASKS_ROLE_MODELS = '{"reviewer":"model-r"}'; assert.equal(roleAgents().reviewer.model, 'model-r'); assert.equal(roleAgents().implementer.model, 'sonnet'); delete process.env.OLAV_TASKS_ROLE_MODELS;
process.env.OLAV_TASKS_ROLE_EFFORT = '{"explorer":"low","reviewer":"bogus"}'; assert.equal(roleAgents().explorer.effort, 'low'); assert.equal(roleAgents().reviewer.effort, 'medium'); delete process.env.OLAV_TASKS_ROLE_EFFORT;
// agents are usable from the LAN by default, YOLO only from the host machine, both adjustable by environment
assert.ok(isLocalClient('127.0.0.1') && isLocalClient('::1') && isLocalClient('::ffff:127.0.0.1'));
assert.ok(!isLocalClient('203.0.113.9') && !isLocalClient(undefined));
if (localIPv4Addresses()[0]) assert.ok(isLocalClient(localIPv4Addresses()[0]));
assert.ok(agentAllowed('203.0.113.9')); assert.ok(!yoloAllowed('203.0.113.9')); assert.ok(yoloAllowed('127.0.0.1'));
process.env.OLAV_TASKS_ALLOW_LAN_YOLO = '1'; assert.ok(yoloAllowed('203.0.113.9')); delete process.env.OLAV_TASKS_ALLOW_LAN_YOLO;
process.env.OLAV_TASKS_AGENT_LAN = '0'; assert.ok(!agentAllowed('203.0.113.9')); assert.ok(agentAllowed('127.0.0.1')); delete process.env.OLAV_TASKS_AGENT_LAN;

const parent = await mkdtemp(join(tmpdir(), 'agent-check-'));
const root = join(parent, 'proj'); await mkdir(root);
await writeFile(join(root, 'T-1.md'), '---\nschema: olav.tasks/v1\nid: T-1\ntitle: Demo\nstatus: todo\ncheck: test -f out.txt && test -z "$ANTHROPIC_API_KEY"\n---\n\nDo the thing.\n');
await writeFile(join(root, 'PROJECT.md'), '# Garden\n\nGoal: tomatoes by June.\nDefinition of done: it is eaten.\n');
await writeFile(join(root, 'T-2.md'), '---\nschema: olav.tasks/v1\nid: T-2\ntitle: Slow check\nstatus: todo\ncheck: sleep 5\n---\n\nSlow.\n');
const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: root });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'init');

// Task runs can no longer be started; runs that already exist (persisted under the state directory) stay reviewable. Seed two.
const state = join(parent, '.olav-tasks-state', 'proj');
const base = git('rev-parse', 'HEAD').toString().trim();
async function seed(id: string, file: string) {
  const dir = join(state, 'worktrees', id); await mkdir(join(state, 'worktrees'), { recursive: true });
  git('worktree', 'add', '-q', '-b', `agent/${id}`, dir);
  await writeFile(join(dir, 'out.txt'), 'hello\n');
  await mkdir(join(state, 'runs'), { recursive: true });
  await writeFile(join(state, 'runs', `${id}.json`), JSON.stringify({ taskId: id, path: file, kind: 'task', title: `${id} earlier run`, agent: 'claude', status: 'idle', events: [], workdir: dir, branch: `agent/${id}`, base }));
  return dir;
}
const worktree = await seed('T-1', 'T-1.md'); await seed('T-2', 'T-2.md');

const seen: { prompt: string; cwd: string; yolo: boolean; effort?: string; systemPrompt?: string; resume?: string }[] = [];
const codexSeen: { cwd: string; yolo: boolean; effort?: string; prompt: string; systemPrompt?: string }[] = [];
const turn: Turn = async function* ({ prompt, cwd, yolo, effort, systemPrompt, resume, canUseTool }) {
  seen.push({ prompt, cwd, yolo: !!yolo, effort, systemPrompt, resume });
  if (prompt.endsWith('budget error')) { yield { type: 'system', session_id: 's2' }; yield { type: 'result', subtype: 'error_max_budget_usd', reported: { cost_usd: 0.3, input: 5, output: 1, cache_read: 0, cache_write: 0, cumulative: true } }; return; }
  yield { type: 'system', session_id: 's1' };
  if (!resume) {
    yield { type: 'assistant', message: { model: 'claude-main', content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { subagent_type: 'explorer' } }] } };
    yield { type: 'assistant', parent_tool_use_id: 'tu1', message: { model: 'claude-haiku', content: [{ type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: 'x' } }] } };
    const allowed = yolo ? true : await canUseTool('Bash', { command: 'ls' });
    yield { type: 'assistant', message: { content: [{ type: 'text', text: allowed ? 'allowed' : 'denied' }] } };
  } else yield { type: 'assistant', message: { content: [{ type: 'text', text: `resumed ${resume}` }] } };
  yield { type: 'result', result: 'ok', reported: { cost_usd: resume ? 0.8 : 0.5, input: 100, output: 10, cache_read: 50, cache_write: 5, cumulative: true } };
};
const codexFake: Turn = async function* ({ prompt, cwd, yolo, effort, systemPrompt }) {
  codexSeen.push({ cwd, yolo: !!yolo, effort, prompt, systemPrompt });
  yield { type: 'assistant', message: { content: [{ type: 'text', text: 'codex did ' + prompt.slice(0, 5) }] } };
  yield { type: 'result', result: 'ok', reported: { input: 7, output: 3, cache_read: 2, cache_write: 0, cumulative: false } };
};
let port = 4900 + Math.floor(Math.random() * 90);
let server = await startServer({ root, name: 't', version: '0', port }, { turns: { claude: turn, codex: codexFake } });
let base_url = `http://127.0.0.1:${port}`;
const call = async (path: string, body?: unknown, method = 'POST') => {
  const res = await fetch(base_url + path, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json', Origin: base_url }, body: JSON.stringify(body) });
  return { status: res.status, data: await res.json() as any };
};
const until = async (fn: () => Promise<boolean>) => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 20)); } throw new Error('timeout'); };
const run = async (id: string) => (await call(`/api/agent/run?task=${id}`)).data;
const idle = (id: string) => until(async () => (await run(id)).status === 'idle');

// starting task runs is gone: no start/ready/start-ready endpoints
assert.notEqual((await call('/api/agent/start', { path: 'T-1.md' })).status, 200);
assert.notEqual((await call('/api/agent/start-ready', {})).status, 200);
assert.notEqual((await call('/api/agent/ready')).status, 200);

// existing task run: the server runs the task's check itself (worktree, secrets stripped), shows the diff, a human accepts, then cleanup
const earlier = (await call('/api/agent/runs')).data.runs;
assert.deepEqual(earlier.map((r: any) => r.taskId).sort(), ['T-1', 'T-2']);
const green = (await call('/api/agent/recheck', { task: 'T-1' })).data.check;
assert.equal(green.ok, true); assert.equal(green.exit, 0);
assert.match((await call('/api/agent/diff?task=T-1')).data.patch, /\+hello/);
process.env.OLAV_TASKS_CHECK_TIMEOUT_MS = '300'; // a timeout kills the whole process group and reports red
const slow = (await call('/api/agent/recheck', { task: 'T-2' })).data.check;
delete process.env.OLAV_TASKS_CHECK_TIMEOUT_MS;
assert.equal(slow.ok, false); assert.equal(slow.timedOut, true); assert.ok(slow.ms < 3000);
assert.equal((await call('/api/agent/cleanup', { task: 'T-2' })).status, 409); // not accepted yet
assert.equal((await call('/api/agent/accept', { task: 'T-1' })).data.accepted, true);
assert.match(await readFile(join(root, 'T-1.md'), 'utf8'), /status: done/);
assert.equal((await call('/api/agent/cleanup', { task: 'T-1' })).data.cleaned, true);
await assert.rejects(readFile(join(worktree, 'out.txt'), 'utf8'));
assert.equal(git('show', 'agent/T-1:out.txt').toString(), 'hello\n');
assert.match((await call('/api/agent/diff?task=T-1')).data.patch, /\+hello/);
assert.equal((await call('/api/agent/send', { task: 'T-1', text: 'x' })).status, 409);
assert.equal((await call('/api/agent/cleanup', { task: 'T-1' })).status, 409);

// meta edit: unknown fields and bad enums are rejected, good ones keep the rest of the file intact
const version = async () => (await call('/api/tasks')).data.tasks.find((t: any) => t.id === 'T-2').version;
assert.equal((await call('/api/task-meta', { path: 'T-2.md', field: 'status', value: 'done', version: await version() }, 'PATCH')).status, 400);
assert.equal((await call('/api/task-meta', { path: 'T-2.md', field: 'model_profile', value: 'huge', version: await version() }, 'PATCH')).status, 400);
assert.equal((await call('/api/task-meta', { path: 'T-2.md', field: 'model_profile', value: 'deep', version: await version() }, 'PATCH')).status, 200);
assert.match(await readFile(join(root, 'T-2.md'), 'utf8'), /^---\nschema: olav.tasks\/v1\nid: T-2\ntitle: Slow check\nstatus: todo\ncheck: sleep 5\nmodel_profile: deep\n---\n\nSlow\.\n$/);

// conversation: runs in the project root, no coordinator rules, YOLO off, asks before a tool call, records usage and resumes
const chat = (await call('/api/agent/chat', { agent: 'claude', text: 'what is in this repo?' })).data;
assert.match(chat.taskId, /^chat-/); assert.equal(chat.kind, 'chat'); assert.equal(chat.title, 'what is in this repo?'); assert.equal(chat.yolo, false);
await until(async () => (await run(chat.taskId)).status === 'blocked');
await call('/api/agent/permission', { task: chat.taskId, id: (await run(chat.taskId)).pending.id, allow: true });
await idle(chat.taskId);
assert.equal(seen.at(-1)!.cwd, root); assert.equal(seen.at(-1)!.yolo, false); assert.equal(seen.at(-1)!.effort, 'high');
// the conversation starts as the project manager: rules as the system prompt, PROJECT.md and the board in the first message only
const firstClaude = seen.at(-1)!;
assert.match(firstClaude.systemPrompt ?? '', /project manager/); assert.match(firstClaude.systemPrompt ?? '', /tasks \.\.\./);
assert.match(firstClaude.prompt, /<project-context>/); assert.match(firstClaude.prompt, /Goal: tomatoes by June/); assert.match(firstClaude.prompt, /Board: 2 tasks \(todo 1, in-progress 0, done 1\)/); assert.match(firstClaude.prompt, /Ready now:\n- T-2: Slow check/); // T-1 was accepted earlier in this script
assert.ok(firstClaude.prompt.endsWith('what is in this repo?'));
const events = (await run(chat.taskId)).events;
assert.equal(events[0].type, 'user'); assert.equal(events[0].text, 'what is in this repo?'); // the log shows the user's words
assert.ok(events.some((e: any) => e.role === 'explorer' && e.model === 'claude-haiku' && e.text.startsWith('Read'))); // subagent activity is attributed
assert.ok(events.some((e: any) => !e.role && e.model === 'claude-main'));
assert.equal((await call('/api/agent/send', { task: chat.taskId, text: 'more' })).status, 200);
await until(async () => (await run(chat.taskId)).events.some((e: any) => e.text === 'resumed s1'));
assert.equal(seen.at(-1)!.prompt, 'more'); assert.match(seen.at(-1)!.systemPrompt ?? '', /project manager/); // no context repeated on resume; the static rules stay
await idle(chat.taskId);
const usage = (await run(chat.taskId)).usage; // Claude totals are cumulative: the latest wins, never summed
assert.equal(usage.cost_usd, 0.8); assert.equal(usage.input, 100); assert.equal(usage.turns, 2);
const listed = (await call('/api/agent/runs')).data.runs.find((r: any) => r.taskId === chat.taskId);
assert.equal(listed.kind, 'chat'); assert.ok(listed.updatedAt);
assert.equal((await call('/api/agent/accept', { task: chat.taskId })).status, 404); // nothing to accept
assert.equal((await call(`/api/agent/diff?task=${chat.taskId}`)).status, 409);
assert.equal((await call('/api/agent/chat', { agent: 'nope', text: 'x' })).status, 400);

// Codex conversation: default effort medium, usage is summed per turn and has no cost (unknown, not zero)
const codex = (await call('/api/agent/chat', { agent: 'codex', text: 'hello codex' })).data;
await idle(codex.taskId);
assert.deepEqual({ cwd: codexSeen.at(-1)!.cwd, yolo: codexSeen.at(-1)!.yolo, effort: codexSeen.at(-1)!.effort }, { cwd: root, yolo: false, effort: 'medium' });
// Codex has no system prompt: rules and context ride in the first message
assert.equal(codexSeen.at(-1)!.systemPrompt, undefined); assert.match(codexSeen.at(-1)!.prompt, /project manager/); assert.match(codexSeen.at(-1)!.prompt, /Goal: tomatoes by June/);
// OLAV_TASKS_PM_CONTEXT=0 starts a plain conversation
process.env.OLAV_TASKS_PM_CONTEXT = '0';
const plain = (await call('/api/agent/chat', { agent: 'claude', text: 'plain hello' })).data; await idle(plain.taskId).catch(() => undefined);
await until(async () => seen.some(x => x.prompt === 'plain hello'));
assert.equal(seen.find(x => x.prompt === 'plain hello')!.systemPrompt, undefined);
delete process.env.OLAV_TASKS_PM_CONTEXT;
const codexUsage = (await run(codex.taskId)).usage;
assert.equal(codexUsage.input, 7); assert.equal(codexUsage.cost_usd, undefined);

// YOLO: accepted from the host machine, recorded for that turn, and follow-up turns default back to off
const yolo = (await call('/api/agent/chat', { agent: 'claude', text: 'go fast', yolo: true })).data;
assert.equal(yolo.yolo, true); await until(async () => seen.some(x => x.prompt.endsWith('go fast'))); assert.equal(seen.find(x => x.prompt.endsWith('go fast'))!.yolo, true);
await idle(yolo.taskId);
await call('/api/agent/send', { task: yolo.taskId, text: 'slower' }); await idle(yolo.taskId);
assert.equal((await run(yolo.taskId)).yolo, false);

// a stop that races the permission request never leaves a conversation blocked
for (let i = 0; i < 5; i++) {
  const racing = (await call('/api/agent/chat', { agent: 'claude', text: `race ${i}` })).data;
  await call('/api/agent/stop', { task: racing.taskId });
  await until(async () => !['running', 'blocked'].includes((await run(racing.taskId)).status));
}

// an error result (budget, turn limit) fails the turn once: a single error line in the log, usage flagged incomplete, still continuable
const budget = (await call('/api/agent/chat', { agent: 'claude', text: 'budget error' })).data;
await until(async () => (await run(budget.taskId)).status === 'failed');
const failedRun = await run(budget.taskId);
assert.deepEqual(failedRun.events.filter((e: any) => e.type === 'error').map((e: any) => e.text), ['error_max_budget_usd']);
assert.equal(failedRun.usageCoverage, 'partial');
assert.equal((await call('/api/agent/send', { task: budget.taskId, text: 'continue' })).status, 200);
await idle(budget.taskId);
assert.equal((await run(budget.taskId)).usageCoverage, 'partial'); // a later success does not erase the gap

// persistence: a fresh server restores the conversation and resumes it by session id
const before = (await run(chat.taskId)).events.length;
server.close();
port += 100; if (port === 5060 || port === 5061) port += 2; // fetch refuses these ports
base_url = `http://127.0.0.1:${port}`;
server = await startServer({ root, name: 't', version: '0', port }, { turns: { claude: turn, codex: codexFake } });
const restored = await run(chat.taskId);
assert.equal(restored.status, 'idle'); assert.equal(restored.events.length, before);
await call('/api/agent/send', { task: chat.taskId, text: 'again' });
await until(async () => (await run(chat.taskId)).events.length > before); await idle(chat.taskId);
assert.equal(seen.at(-1)!.resume, 's1');
// activity (read-only, from git): accepting T-1 earlier changed its task file; that edit is listed and its diff served, unlisted paths are refused
const act = (await call('/api/activity')).data;
assert.equal(act.git, true); assert.ok(act.commits.some((c: any) => c.subject === 'init'));
assert.ok(act.changes.some((c: any) => c.path === 'T-1.md' && c.status === 'M'));
assert.match((await call('/api/activity/diff?path=T-1.md')).data.diff, /\+status: done/);
assert.equal((await call('/api/activity/diff?path=PROJECT.md')).status, 400); // committed and unchanged: not a listed change
assert.equal((await call('/api/activity/diff?path=..%2F..%2Fetc%2Fpasswd')).status, 400);
assert.equal((await call('/api/activity/diff')).status, 400);
assert.equal((await fetch(base_url + '/api/agent/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403); // writes need the app's own Origin
server.close();
console.log('agent-check ok');
