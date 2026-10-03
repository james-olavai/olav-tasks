import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { claimTask, newTask, validateProject } from '../src/pm-tools.js';

const run = promisify(execFile);
const cli = (...args: string[]) => run(process.execPath, ['--import', 'tsx', 'src/cli.ts', ...args], { cwd: process.cwd() }).then(r => ({ code: 0, out: r.stdout, err: r.stderr }), (e: any) => ({ code: e.code as number, out: String(e.stdout), err: String(e.stderr) }));
const task = (id: string, extra = '', status = 'todo') => `---\nschema: olav.tasks/v1\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\n${extra}---\n\nbody\n`;
async function project(files: Record<string, string>) {
  const parent = await mkdtemp(join(tmpdir(), 'pm-tools-')); const root = join(parent, 'proj'); await mkdir(root);
  for (const [name, text] of Object.entries(files)) { await mkdir(join(root, name, '..'), { recursive: true }); await writeFile(join(root, name), text); }
  return { root, done: () => rm(parent, { recursive: true, force: true }) };
}

test('claim sets in-progress and the assignee in one write, keeps the rest of the file, and is idempotent for the same assignee', async () => {
  const p = await project({ 'backlog/A-001.md': task('A-001', 'priority: P1\nunknown_field: keep me\n') });
  try {
    const first = await claimTask(p.root, 'A-001', 'agent:codex');
    assert.equal(first.already, false);
    const text = await readFile(join(p.root, 'backlog/A-001.md'), 'utf8');
    assert.match(text, /status: in-progress/); assert.match(text, /assignee: agent:codex/); assert.match(text, /unknown_field: keep me/); assert.match(text, /priority: P1/);
    assert.equal((await claimTask(p.root, 'A-001', 'agent:codex')).already, true);
    await assert.rejects(claimTask(p.root, 'A-001', 'agent:claude'), /already claimed by agent:codex/);
  } finally { await p.done(); }
});

test('claim refuses what is not ready, with the reason', async () => {
  const p = await project({
    'A-001.md': task('A-001'), 'A-002.md': task('A-002', 'depends_on: [A-001]\n'), 'A-003.md': task('A-003', 'blocked_by: waiting for the customer\n'),
    'A-004.md': task('A-004', '', 'done'), 'A-005.md': task('A-005', 'assignee: human:alice\n'),
  });
  try {
    await assert.rejects(claimTask(p.root, 'A-002', 'agent:x'), /waiting for A-001/);
    await assert.rejects(claimTask(p.root, 'A-003', 'agent:x'), /blocked: waiting for the customer/);
    await assert.rejects(claimTask(p.root, 'A-004', 'agent:x'), /status is done/);
    await assert.rejects(claimTask(p.root, 'A-005', 'agent:x'), /assigned to human:alice/);
    await assert.rejects(claimTask(p.root, 'A-001', 'someone'), /human:<id> or agent:<id>/);
    await assert.rejects(claimTask(p.root, 'A-999', 'agent:x'), /No task with ID/);
  } finally { await p.done(); }
});

test('claim fails closed while the board has diagnostics', async () => {
  const p = await project({ 'A-001.md': task('A-001'), 'bad.md': task('A-002', 'depends_on: [A-404]\n') });
  try { await assert.rejects(claimTask(p.root, 'A-001', 'agent:x'), /incomplete/); } finally { await p.done(); }
});

test('two processes racing for the same task: exactly one wins', async () => {
  const p = await project({ 'A-001.md': task('A-001') });
  try {
    const results = await Promise.all([cli('tasks', 'claim', p.root, 'A-001', '--as', 'agent:one'), cli('tasks', 'claim', p.root, 'A-001', '--as', 'agent:two'), cli('tasks', 'claim', p.root, 'A-001', '--as', 'agent:three')]);
    assert.equal(results.filter(r => r.code === 0).length, 1, results.map(r => r.err).join('|'));
    assert.equal(results.filter(r => r.code !== 0 && /already claimed|in progress/.test(r.err)).length, 2);
    const winner = /assignee: (agent:\w+)/.exec(await readFile(join(p.root, 'A-001.md'), 'utf8'))![1];
    assert.ok(results.some(r => r.code === 0 && r.out.includes(winner)));
  } finally { await p.done(); }
});

test('new allocates the next ID in the dominant prefix and directory, validates links, and quotes awkward titles', async () => {
  const p = await project({ 'backlog/tasks/F-AGENT-009.md': task('F-AGENT-009'), 'backlog/tasks/F-AGENT-010.md': task('F-AGENT-010'), 'backlog/tasks/OT-001.md': task('OT-001') });
  try {
    const created = await newTask(p.root, { title: 'Fix `parse`: "quoted" title', priority: 'P1', depends: ['F-AGENT-010'] });
    assert.equal(created.id, 'F-AGENT-011'); assert.equal(created.path, 'backlog/tasks/F-AGENT-011.md');
    assert.equal((await validateProject(p.root)).ok, true); // the awkward title is valid YAML
    assert.match(await readFile(join(p.root, created.path), 'utf8'), /depends_on: \["F-AGENT-010"\]/);
    assert.equal((await newTask(p.root, { title: 'Other prefix', prefix: 'OT' })).id, 'OT-002');
    await assert.rejects(newTask(p.root, { title: 'x', depends: ['nope'] }), /Unknown dependency/);
    await assert.rejects(newTask(p.root, { title: '  ' }), /title is required/);
    await assert.rejects(newTask(p.root, { title: 'x', priority: 'P9' }), /priority/);
  } finally { await p.done(); }
});

test('new in an empty project starts at T-001 under backlog/tasks, and concurrent creators never share an ID', async () => {
  const p = await project({ 'README.md': '# empty\n' });
  try {
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => cli('tasks', 'new', p.root, '--title', `Task ${i}`, '--json')));
    assert.ok(results.every(r => r.code === 0), results.map(r => r.err).join('|'));
    const ids = results.map(r => JSON.parse(r.out).id as string);
    assert.equal(new Set(ids).size, 6);
    assert.ok(ids.every(id => /^T-\d{3}$/.test(id)));
    assert.deepEqual((await validateProject(p.root)).diagnostics, []);
  } finally { await p.done(); }
});

test('validate reports what the board would flag and exits 1', async () => {
  const p = await project({ 'A-001.md': task('A-001', 'depends_on: [A-002]\n'), 'A-002.md': task('A-002', 'depends_on: [A-001]\n'), 'broken.md': '---\nschema: olav.tasks/v1\nid: A-003\ntitle: has: a colon\nstatus: todo\n---\n' });
  try {
    const report = await validateProject(p.root);
    assert.equal(report.ok, false);
    assert.ok(report.diagnostics.some(d => /cycle/.test(d.message)));
    assert.ok(report.diagnostics.some(d => d.path === 'broken.md'));
    const viaCli = await cli('tasks', 'validate', p.root);
    assert.equal(viaCli.code, 1); assert.match(viaCli.out, /diagnostics/);
  } finally { await p.done(); }
  const clean = await project({ 'A-001.md': task('A-001') });
  try { const r = await cli('tasks', 'validate', clean.root); assert.equal(r.code, 0); assert.match(r.out, /^OK: 1 tasks/); } finally { await clean.done(); }
});
