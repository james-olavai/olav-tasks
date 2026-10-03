import assert from 'node:assert/strict';
import { after, test, mock } from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

type Script = (signal: AbortSignal) => AsyncGenerator<any>;
const scripts: Script[] = [];
const calls: { kind: 'start' | 'resume'; id?: string; options: any; prompt?: string }[] = [];
class CodexMock {
  startThread(options: any) { calls.push({ kind: 'start', options }); return this.thread(); }
  resumeThread(id: string, options: any) { calls.push({ kind: 'resume', id, options }); return this.thread(); }
  private thread() { return { runStreamed: async (prompt: string, options: { signal: AbortSignal }) => {
    calls.at(-1)!.prompt = prompt;
    const script = scripts.shift();
    if (!script) throw new Error('No mock stream queued; real SDK must never run.');
    return { events: script(options.signal) };
  } }; }
}
mock.module('@openai/codex-sdk', { namedExports: { Codex: CodexMock } });
const { AgentRuns, codexTurn } = await import('../src/agent.js');
const { ProjectFiles } = await import('../src/project-files.js');
const parent = await mkdtemp(join(tmpdir(), 'olav-codex-chat-fix-'));
after(async () => { await rm(parent, { recursive: true, force: true }); });
let sequence = 0;
async function fixture() {
  const root = join(parent, `project-${++sequence}`);
  await mkdir(root);
  return { root, state: join(dirname(root), '.olav-tasks-state', basename(root), 'runs'), runs: new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn }) };
}
const started = (id: string) => ({ type: 'thread.started', thread_id: id });
const completed = (input = 10, output = 2, cache = 3, reasoning?: number) => ({ type: 'turn.completed', usage: { input_tokens: input, output_tokens: output, cached_input_tokens: cache, cache_write_input_tokens: 0, ...(reasoning === undefined ? {} : { reasoning_output_tokens: reasoning }) } });
const success = (id: string, input = 10, output = 2): Script => async function* () { yield started(id); yield completed(input, output); };
async function until(check: () => boolean) { for (let n = 0; n < 200; n++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error('Timed out waiting for run'); }
async function settled(runs: InstanceType<typeof AgentRuns>, id: string) { await until(() => !['running', 'blocked'].includes(runs.get(id).status)); return runs.get(id); }

test('thread ID is durable before the stream advances; reload resumes with only the new prompt', async () => {
  const { root, state, runs } = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
  scripts.push(async function* (signal) { yield started('durable-id'); reached(); await new Promise<void>(resolve => { release = resolve; signal.addEventListener('abort', resolve, { once: true }); }); });
  const id = runs.chat('codex', 'original instructions').taskId;
  await reachedPromise;
  const disk = JSON.parse(await readFile(join(state, `${id}.json`), 'utf8'));
  assert.equal(disk.sessionId, 'durable-id');
  const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  scripts.push(success('durable-id'));
  restored.send(id, 'continue');
  assert.equal((await settled(restored, id)).status, 'idle');
  assert.deepEqual(calls.at(-1) && { kind: calls.at(-1)!.kind, id: calls.at(-1)!.id, prompt: calls.at(-1)!.prompt }, { kind: 'resume', id: 'durable-id', prompt: 'continue' });
  runs.stop(id); release(); await settled(runs, id);
});

test('missing legacy thread ID fails explicitly, while saved model is sent on resume', async () => {
  const { root, state, runs } = await fixture();
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'legacy.json'), JSON.stringify({ taskId: 'legacy', path: '', agent: 'codex', kind: 'chat', model: 'requested-model', status: 'idle', events: [{ seq: 1, type: 'user', text: 'old' }], usage: { input: 1, output: 1, cache_read: 0, cache_write: 0, turns: 1 }, workdir: root, sessionId: 'old-id' }));
  await writeFile(join(state, 'broken.json'), JSON.stringify({ taskId: 'broken', path: '', agent: 'codex', kind: 'chat', status: 'idle', events: [{ seq: 1, type: 'user', text: 'old' }], workdir: root }));
  const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  const before = calls.length;
  assert.throws(() => restored.send('broken', 'continue'), /thread|session|resume/i);
  assert.equal(calls.length, before);
  assert.equal(restored.get('broken').status, 'failed');
  scripts.push(success('old-id'));
  restored.send('legacy', 'continue');
  assert.equal((await settled(restored, 'legacy')).status, 'idle');
  assert.equal(calls.at(-1)?.options.model, 'requested-model');
  assert.equal(restored.get('legacy').usageCoverage, 'unknown');
  scripts.push(success('fresh'));
  const fresh = runs.chat('codex', 'fresh');
  await settled(runs, fresh.taskId);
  assert.equal(calls.at(-1)?.options.model, undefined);
});

test('known subtotal and incomplete coverage survive failure, stop, success and reload', async () => {
  const { root, runs } = await fixture();
  scripts.push(success('usage-id', 100, 20));
  const id = runs.chat('codex', 'one').taskId;
  await settled(runs, id);
  scripts.push(success('usage-id', 30, 4)); runs.send(id, 'two'); await settled(runs, id);
  scripts.push(async function* () { yield started('usage-id'); yield { type: 'turn.failed', error: { message: 'failed after work' } }; });
  runs.send(id, 'three');
  let detail = await settled(runs, id);
  assert.equal(detail.status, 'failed');
  assert.deepEqual([detail.usage.input, detail.usage.output, detail.usage.turns], [130, 24, 2]);
  assert.equal(detail.usageCoverage, 'partial');
  scripts.push(async function* (signal) { yield started('usage-id'); await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); });
  runs.send(id, 'four'); await until(() => runs.get(id).status === 'running'); runs.stop(id); await settled(runs, id);
  scripts.push(success('usage-id', 5, 1)); runs.send(id, 'five'); detail = await settled(runs, id);
  assert.deepEqual([detail.usage.input, detail.usage.output, detail.usage.turns], [135, 25, 3]);
  assert.equal(detail.usageCoverage, 'partial');
  const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  assert.equal(restored.get(id).usageCoverage, 'partial');
});

test('reload marks an interrupted turn as incomplete without losing earlier usage', async () => {
  const { root, runs } = await fixture();
  scripts.push(success('interrupted', 40, 7));
  const id = runs.chat('codex', 'first').taskId;
  await settled(runs, id);
  let release!: () => void;
  let reached!: () => void;
  const reachedPromise = new Promise<void>(resolve => { reached = resolve; });
  scripts.push(async function* (signal) { yield started('interrupted'); reached(); await new Promise<void>(resolve => { release = resolve; if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); });
  runs.send(id, 'unfinished');
  await reachedPromise;
  const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  assert.equal(restored.get(id).status, 'stopped');
  assert.equal(restored.get(id).usageCoverage, 'partial');
  assert.equal(restored.get(id).usage.input, 40);
  runs.stop(id); release(); await settled(runs, id);
});

test('completed, failed, thrown, early EOF and abort close streams and settle status', async () => {
  for (const [kind, ending, expected] of [
    ['completed', completed(), 'idle'],
    ['failed', { type: 'turn.failed', error: { message: 'failure' } }, 'failed'],
    ['throw', null, 'failed'],
    ['EOF', undefined, 'failed'],
    ['abort', undefined, 'stopped'],
  ] as const) {
    const { runs } = await fixture();
    let closed = false;
    scripts.push(async function* (signal) { try { yield started(kind); if (kind === 'throw') throw new Error('stream failure'); if (kind === 'abort') await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); }); else if (ending) yield ending; } finally { closed = true; } });
    const id = runs.chat('codex', kind).taskId;
    if (kind === 'abort') { await until(() => runs.get(id).status === 'running' && calls.at(-1)?.prompt === kind); runs.stop(id); }
    const detail = await settled(runs, id);
    assert.equal(detail.status, expected, kind);
    assert.equal(closed, true, `${kind} iterator finally`);
    if (kind !== 'completed') assert.notEqual(detail.usageCoverage, 'complete');
  }
});

test('thread ID save failure is visible and prevents a success state', async () => {
  const { state, runs } = await fixture();
  let release!: () => void;
  let ready!: () => void;
  let closed = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  scripts.push(async function* () { try { ready(); await gate; yield started('cannot-save'); yield completed(); } finally { closed = true; } });
  const id = runs.chat('codex', 'save failure').taskId;
  await readyPromise;
  const path = join(state, `${id}.json`);
  await rm(path);
  await mkdir(path);
  release();
  const detail = await settled(runs, id);
  assert.equal(detail.status, 'failed');
  assert.match(detail.persistenceError ?? '', /could not be saved/i);
  assert.equal(detail.usageCoverage, 'unknown');
  assert.equal(closed, true);
});

test('stop retains stopped and reports persistence failure when the final save fails', async () => {
  const { state, runs } = await fixture();
  let waiting!: () => void;
  let closed = false;
  const waitingPromise = new Promise<void>(resolve => { waiting = resolve; });
  scripts.push(async function* (signal) {
    try {
      yield started('stop-save-id');
      waiting();
      await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
    } finally { closed = true; }
  });
  const id = runs.chat('codex', 'stop and fail save').taskId;
  await waitingPromise;
  const path = join(state, `${id}.json`);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sessionId, 'stop-save-id');
  await rm(path);
  await mkdir(path);
  runs.stop(id);
  const detail = await settled(runs, id);
  assert.equal(detail.status, 'stopped');
  assert.equal(detail.usageCoverage, 'unknown');
  assert.match(detail.persistenceError ?? '', /could not be saved/i);
  assert.equal(detail.pending, undefined);
  assert.equal(closed, true);
});

test('failed Codex turn skips the task automatic check', async () => {
  const { root, state } = await fixture();
  await writeFile(join(root, 'T.md'), '---\nschema: olav.tasks/v1\nid: T\ntitle: Mock task\nstatus: todo\ncheck: touch auto-check-ran\n---\n');
  await mkdir(state, { recursive: true });
  await writeFile(join(state, 'T.json'), JSON.stringify({ taskId: 'T', path: 'T.md', agent: 'codex', status: 'idle', sessionId: 'task-thread', events: [], workdir: root }));
  const runs = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  scripts.push(async function* () { yield started('task-thread'); yield { type: 'turn.failed', error: { message: 'failed' } }; });
  runs.send('T', 'try task');
  assert.equal((await settled(runs, 'T')).status, 'failed');
  assert.equal(existsSync(join(root, 'auto-check-ran')), false);
});

test('a stopped pending approval is denied and cleared', async () => {
  const { root } = await fixture();
  let denied: boolean | undefined;
  const permissionTurn = async function* ({ canUseTool }: { canUseTool: (tool: string, input: Record<string, unknown>) => Promise<boolean> }) {
    denied = !(await canUseTool('Read', { file: 'mock' }));
    yield { type: 'result', result: 'done' };
  };
  const runs = new AgentRuns(new ProjectFiles(root), root, { codex: permissionTurn });
  const id = runs.chat('codex', 'permission').taskId;
  await until(() => runs.get(id).status === 'blocked');
  runs.stop(id);
  const detail = await settled(runs, id);
  assert.equal(detail.status, 'stopped');
  assert.equal(detail.pending, undefined);
  assert.equal(denied, true);
});

test('explicit Codex reasoning wins over the environment, persists on resume, and invalid requests fail closed', async () => {
  const previous = process.env.OLAV_TASKS_EFFORT;
  process.env.OLAV_TASKS_EFFORT = '{"codex":"low"}';
  try {
    const { root, runs } = await fixture();
    const before = calls.length;
    assert.throws(() => runs.chat('codex', 'bad', false, 'bogus'), /reasoning/i);
    assert.throws(() => runs.chat('codex', 'bad', false, null), /reasoning/i);
    assert.equal(calls.length, before);
    scripts.push(async function* () { yield started('explicit-reasoning'); yield completed(8, 3, 1, 2); });
    const id = runs.chat('codex', 'high risk', false, 'xhigh').taskId;
    await settled(runs, id);
    assert.equal(calls.at(-1)?.options.modelReasoningEffort, 'xhigh');
    assert.equal(runs.get(id).reasoningEffort, 'xhigh');
    const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
    scripts.push(async function* () { yield started('explicit-reasoning'); yield completed(4, 1, 0, 1); });
    restored.send(id, 'continue'); await settled(restored, id);
    assert.equal(calls.at(-1)?.kind, 'resume');
    assert.equal(calls.at(-1)?.options.modelReasoningEffort, 'xhigh');
    scripts.push(async function* () { yield started('default-reasoning'); yield completed(); });
    const normal = runs.chat('codex', 'default').taskId;
    await settled(runs, normal);
    assert.equal(calls.at(-1)?.options.modelReasoningEffort, 'low');
    assert.equal(runs.get(normal).reasoningEffort, null);
    assert.equal(runs.get(normal).usage.reasoning_coverage, 'unknown');
    scripts.push(async function* () { yield started('persistent-reasoning'); yield completed(); });
    const persistent = runs.chat('codex', 'persistent', false, 'persistent').taskId;
    await settled(runs, persistent);
    assert.equal(calls.at(-1)?.options.modelReasoningEffort, 'persistent');
    const withClaude = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn, claude: async function* () {} });
    assert.throws(() => withClaude.chat('claude', 'unsupported', false, 'high'), /reasoning/i);
  } finally {
    if (previous === undefined) delete process.env.OLAV_TASKS_EFFORT;
    else process.env.OLAV_TASKS_EFFORT = previous;
  }
});

test('reasoning output is a separate known subtotal; missing segments and legacy history stay incomplete', async () => {
  const { root, state, runs } = await fixture();
  scripts.push(async function* () { yield started('reasoning-id'); yield completed(10, 4, 2, 0); });
  const id = runs.chat('codex', 'first').taskId;
  let detail = await settled(runs, id);
  assert.equal(detail.usage.reasoning_output, 0);
  assert.equal(detail.usage.reasoning_coverage, 'complete');
  assert.equal(detail.usage.output, 4);
  scripts.push(async function* () { yield started('reasoning-id'); yield completed(6, 3, 1, 7); });
  runs.send(id, 'second'); detail = await settled(runs, id);
  assert.equal(detail.usage.reasoning_output, 7);
  assert.equal(detail.usage.reasoning_coverage, 'complete');
  assert.equal(detail.usage.output, 7);
  assert.equal(detail.usage.cache_read, 3);
  scripts.push(async function* () { yield started('reasoning-id'); yield completed(2, 1); });
  runs.send(id, 'missing reasoning'); detail = await settled(runs, id);
  assert.equal(detail.usage.reasoning_output, 7);
  assert.equal(detail.usage.reasoning_coverage, 'partial');
  scripts.push(async function* () { yield started('reasoning-id'); yield { type: 'turn.failed', error: { message: 'failed after output' } }; });
  runs.send(id, 'failed'); detail = await settled(runs, id);
  assert.equal(detail.usage.reasoning_coverage, 'partial');
  scripts.push(async function* () { yield started('reasoning-id'); yield completed(5, 2, 0, 3); });
  runs.send(id, 'recover'); detail = await settled(runs, id);
  assert.equal(detail.usage.reasoning_output, 10);
  assert.equal(detail.usage.reasoning_coverage, 'partial');
  assert.equal(detail.usage.output, 10);
  const restored = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  assert.equal(restored.get(id).usage.reasoning_output, 10);
  assert.equal(restored.get(id).usage.reasoning_coverage, 'partial');

  await writeFile(join(state, 'old-reasoning.json'), JSON.stringify({ taskId: 'old-reasoning', path: '', agent: 'codex', kind: 'chat', status: 'idle', sessionId: 'old-reasoning-id', events: [{ seq: 1, type: 'user', text: 'old' }], workdir: root, usage: { input: 10, output: 4, cache_read: 0, cache_write: 0, turns: 1 }, usageCoverage: 'complete' }));
  const legacy = new AgentRuns(new ProjectFiles(root), root, { codex: codexTurn });
  assert.equal(legacy.get('old-reasoning').usage.reasoning_output, undefined);
  assert.equal(legacy.get('old-reasoning').usage.reasoning_coverage ?? 'unknown', 'unknown');
  scripts.push(async function* () { yield started('old-reasoning-id'); yield completed(2, 1, 0, 2); });
  legacy.send('old-reasoning', 'next'); detail = await settled(legacy, 'old-reasoning');
  assert.equal(detail.usage.reasoning_output, 2);
  assert.equal(detail.usage.reasoning_coverage, 'partial');
});
