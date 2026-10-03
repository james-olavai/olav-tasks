import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTask, replaceTaskStatus, type Task } from '../src/tasks.js';
import { ProjectFiles } from '../src/project-files.js';
import { taskReadiness } from '../src/task-readiness.js';

const task = (id: string, overrides: Partial<Task> = {}): Task => ({ path: `${id}.md`, id, title: id, status: 'todo', depends_on: [], version: 'v', ...overrides });
const listing = (tasks: Task[], diagnostics: { path: string; message: string }[] = [], truncated = false) => ({ tasks, diagnostics, truncated, revision: 'revision' });

test('optional fields parse and status replacement preserves original bytes around scalar', () => {
  const source = '\uFEFF---\r\nschema: olav.tasks/v1\r\nid: T-1\r\ntitle: Child\r\nstatus: "todo"\r\nparent: T-0\r\nblocked_by: external gate\r\nunknown: keep\r\n---\r\nbody\r\n';
  assert.equal(parseTask(source, 'T-1.md', 'v').task?.parent, 'T-0');
  assert.equal(parseTask(source, 'T-1.md', 'v').task?.blocked_by, 'external gate');
  assert.equal(replaceTaskStatus(source, 'in-progress'), source.replace('status: "todo"', 'status: "in-progress"'));
  for (const field of ['parent', 'blocked_by']) assert.throws(() => parseTask(source.replace(`${field}: ${field === 'parent' ? 'T-0' : 'external gate'}`, `${field}: ""`), 'x', 'v'), /nonempty/);
});

test('ready respects dependencies, blocks, children and stable priority ordering', () => {
  const result = taskReadiness(listing([
    task('P', { priority: 'P0' }), task('C', { parent: 'P' }), task('D', { status: 'done' }),
    task('B', { priority: 'P1', blocked_by: 'review' }), task('A', { priority: 'P1', depends_on: ['D'] }),
    task('Z', { depends_on: ['C'] }),
  ]));
  assert.equal(result.complete, true);
  assert.deepEqual(result.tasks.map(item => item.id), ['A', 'C']);
  assert.deepEqual(result.excluded.map(item => item.id), ['P', 'B', 'D', 'Z']);
  assert.deepEqual(taskReadiness(listing([task('P'), task('C', { parent: 'P', status: 'done' })])).tasks.map(item => item.id), ['P']);
});

test('invalid graph and incomplete scans fail closed even when linked nodes are done', () => {
  const invalid = [
    [task('A', { depends_on: ['missing'] })],
    [task('A', { status: 'done', depends_on: ['B'] }), task('B', { status: 'done', depends_on: ['A'] }), task('C')],
    [task('A', { parent: 'B' }), task('B', { parent: 'A', status: 'done' })],
    [task('A', { parent: 'missing' })],
    [task('A'), task('A', { path: 'other.md' })],
  ];
  for (const tasks of invalid) {
    const result = taskReadiness(listing(tasks));
    assert.equal(result.complete, false);
    assert.equal(result.tasks.length, 0);
    assert.ok(result.diagnostics.length);
  }
  for (const result of [taskReadiness(listing([task('A')], [{ path: 'x', message: 'parse error' }])), taskReadiness(listing([task('A')], [], true))]) {
    assert.equal(result.complete, false);
    assert.equal(result.tasks.length, 0);
  }
});

test('6000-task dependency and parent chains remain complete, including deep cycles', () => {
  const count = 6000;
  for (const relation of ['depends_on', 'parent'] as const) {
    const chain = Array.from({ length: count }, (_, index) => task(`T-${index}`, {
      status: index === 0 ? 'todo' : 'done',
      ...(relation === 'depends_on' ? { depends_on: index + 1 < count ? [`T-${index + 1}`] : [] } : { parent: index + 1 < count ? `T-${index + 1}` : undefined }),
    }));
    const valid = taskReadiness(listing(chain));
    assert.equal(valid.complete, true, relation);
    assert.deepEqual(valid.tasks.map(item => item.id), ['T-0'], relation);
    const cyclic = chain.map(item => ({ ...item }));
    if (relation === 'depends_on') cyclic[count - 1].depends_on = ['T-0'];
    else cyclic[count - 1].parent = 'T-0';
    const invalid = taskReadiness(listing(cyclic));
    assert.equal(invalid.complete, false, relation);
    assert.deepEqual(invalid.tasks, [], relation);
    assert.ok(invalid.diagnostics.some(item => item.message.includes('cycle')), relation);
  }
});

test('bounded project scan returns metadata and diagnoses invalid task without writing files', async () => {
  const root = await mkdtemp(join(process.cwd(), 'node_modules', '.olav-task-readiness-'));
  try {
    await mkdir(join(root, 'backlog'));
    const good = '---\nschema: olav.tasks/v1\nid: A\ntitle: A\nstatus: todo\nparent: P\nblocked_by: gate\n---\nbody\n';
    const parent = '---\nschema: olav.tasks/v1\nid: P\ntitle: Parent\nstatus: done\n---\n';
    await writeFile(join(root, 'backlog', 'A.md'), good);
    await writeFile(join(root, 'backlog', 'P.md'), parent);
    const files = new ProjectFiles(root);
    const scan = await files.tasks();
    assert.equal(scan.truncated, false);
    assert.equal(scan.tasks.find(item => item.id === 'A')?.parent, 'P');
    assert.deepEqual(taskReadiness(scan).tasks, []);
    assert.equal(await readFile(join(root, 'backlog', 'A.md'), 'utf8'), good);
    await writeFile(join(root, 'backlog', 'bad.md'), good.replace('id: A', 'id: B').replace('parent: P', 'parent: ""'));
    assert.equal(taskReadiness(await files.tasks()).complete, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
