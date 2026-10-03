import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles } from '../src/project-files.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildDigest, renderDigest } from '../src/task-digest.js';
import type { Task } from '../src/tasks.js';

const task = (id: string, extra = '', status = 'todo') => `---\nschema: olav.tasks/v1\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\n${extra}---\n`;
async function project(files: Record<string, string>) {
  const parent = await mkdtemp(join(tmpdir(), 'digest-')); const root = join(parent, 'proj'); await mkdir(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return { root, files: new ProjectFiles(root), done: () => rm(parent, { recursive: true, force: true }) };
}
const NOW = new Date('2026-10-10T12:00:00');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

test('digest finds what needs a person, what is late, what is stale, parent progress and the critical path', async () => {
  const p = await project({
    'A-1.md': task('A-1', '', 'done'),
    'A-2.md': task('A-2', 'depends_on: [A-1]\nend_date: 2026-10-05\nstart_date: 2026-10-01\n'),       // overdue by 5 days, open
    'A-3.md': task('A-3', 'depends_on: [A-2]\n'),
    'A-4.md': task('A-4', 'depends_on: [A-3]\n'),                                                      // chain A-2 <- A-3 <- A-4
    'B-1.md': task('B-1', 'assignee: agent:codex\n', 'in-progress'),                                  // stale: 12 days idle
    'B-2.md': task('B-2', 'assignee: agent:claude\n', 'in-progress'),                                 // fresh: 1 day idle
    'C-1.md': task('C-1', 'blocked_by: "needs decision: ship or wait?"\n'),
    'P-1.md': task('P-1'), 'P-2.md': task('P-2', 'parent: P-1\n', 'done'), 'P-3.md': task('P-3', 'parent: P-1\n'),
  });
  try {
    const idle: Record<string, number> = { 'B-1': 12, 'B-2': 1 };
    const d = await buildDigest(p.root, await p.files.tasks(), { now: NOW, activity: async (t: Task) => daysAgo(idle[t.id] ?? 0) });
    assert.equal(d.complete, true);
    assert.deepEqual(d.counts, { todo: 6, 'in-progress': 2, done: 2 });
    assert.deepEqual(d.decisions, [{ id: 'C-1', title: 'Task C-1', waiting_on: 'needs decision: ship or wait?' }]);
    assert.deepEqual(d.overdue.map(x => [x.id, x.days_late]), [['A-2', 5]]);
    assert.deepEqual(d.stale.map(x => x.id), ['B-1']);
    assert.deepEqual(d.in_progress.map(x => [x.id, x.days_idle]).sort(), [['B-1', 12], ['B-2', 1]]);
    assert.deepEqual(d.parents, [{ id: 'P-1', title: 'Task P-1', done: 1, total: 2 }]);
    assert.deepEqual(d.critical_path, { length: 3, ids: ['A-2', 'A-3', 'A-4'] });
    assert.ok(d.ready.some(x => x.id === 'A-2') && !d.ready.some(x => x.id === 'A-3'));
    const text = renderDigest(d);
    for (const needle of ['## Waiting on a person', 'C-1', '## Overdue', '5 days late', '## Stale', 'B-1', 'P-1 Task P-1: 1/2 children done', 'A-2 → A-3 → A-4']) assert.ok(text.includes(needle), needle);
  } finally { await p.done(); }
});

test('a healthy board says nothing needs attention; a broken board says fix the diagnostics first and skips the critical path', async () => {
  const healthy = await project({ 'A-1.md': task('A-1', '', 'done') });
  try { assert.match(renderDigest(await buildDigest(healthy.root, await healthy.files.tasks(), { now: NOW })), /Nothing needs attention/); } finally { await healthy.done(); }
  const broken = await project({ 'A-1.md': task('A-1', 'depends_on: [A-2]\n'), 'A-2.md': task('A-2', 'depends_on: [A-1]\n') });
  try {
    const d = await buildDigest(broken.root, await broken.files.tasks(), { now: NOW });
    assert.equal(d.complete, false); assert.deepEqual(d.critical_path, { length: 0, ids: [] }); assert.deepEqual(d.ready, []);
    assert.match(renderDigest(d), /has \d+ diagnostics/);
  } finally { await broken.done(); }
});

test('last activity falls back to the file modification time outside git', async () => {
  const p = await project({ 'A-1.md': task('A-1', '', 'in-progress') });
  try {
    const d = await buildDigest(p.root, await p.files.tasks(), { now: new Date() });
    assert.equal(d.in_progress[0].days_idle, 0); // just written
  } finally { await p.done(); }
});

test('the digest command prints Markdown or JSON and exits 0, even for a board with problems', async () => {
  const p = await project({ 'A-1.md': task('A-1', 'blocked_by: "needs decision: x?"\n'), 'bad.md': '---\nschema: olav.tasks/v1\nid: A-2\ntitle: a: b\nstatus: todo\n---\n' });
  try {
    const run = (...args: string[]) => promisify(execFile)(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'tasks', 'digest', p.root, ...args], { cwd: process.cwd() });
    const text = (await run()).stdout; assert.match(text, /^# Project digest/); assert.match(text, /has 1 diagnostics/); assert.match(text, /Waiting on a person/);
    const json = JSON.parse((await run('--json')).stdout); assert.equal(json.complete, false); assert.equal(json.decisions.length, 1);
    await assert.rejects(run('--stale-days', 'abc'), /non-negative number/);
  } finally { await p.done(); }
});
