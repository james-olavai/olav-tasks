import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectFiles } from '../src/project-files.js';
import { pmRules, projectBrief } from '../src/pm-context.js';

const task = (id: string, extra = '', status = 'todo') => `---\nschema: olav.tasks/v1\nid: ${id}\ntitle: Task ${id}\nstatus: ${status}\n${extra}---\n`;
async function project(files: Record<string, string>) {
  const parent = await mkdtemp(join(tmpdir(), 'pm-context-')); const root = join(parent, 'proj'); await mkdir(root);
  for (const [name, text] of Object.entries(files)) await writeFile(join(root, name), text);
  return { root, files: new ProjectFiles(root), done: () => rm(parent, { recursive: true, force: true }) };
}

test('the brief carries PROJECT.md, counts, what is in progress, what is ready and what waits on a person', async () => {
  const p = await project({ 'PROJECT.md': '# Goals\n\nShip by June.\n', 'A-1.md': task('A-1', 'priority: P0\n'), 'A-2.md': task('A-2', 'depends_on: [A-1]\n'),
    'A-3.md': task('A-3', 'assignee: agent:codex\n', 'in-progress'), 'A-4.md': task('A-4', 'blocked_by: "needs decision: which vendor?"\n') });
  try {
    const brief = await projectBrief(p.root, p.files);
    assert.match(brief, /^<project-context>/); assert.match(brief, /<\/project-context>$/);
    assert.match(brief, /Ship by June/);
    assert.match(brief, /Board: 4 tasks \(todo 3, in-progress 1, done 0\); 0 diagnostics/);
    assert.match(brief, /In progress:\n- A-3 \(agent:codex\): Task A-3/);
    assert.match(brief, /Ready now:\n- A-1 \(P0\): Task A-1/); assert.doesNotMatch(brief, /- A-2 /); // waits for A-1; A-4 is blocked
    assert.match(brief, /Waiting on a person or a decision:\n- A-4: needs decision: which vendor\?/);
  } finally { await p.done(); }
});

test('without PROJECT.md the brief says so; with diagnostics it refuses to list ready work', async () => {
  const p = await project({ 'A-1.md': task('A-1'), 'bad.md': '---\nschema: olav.tasks/v1\nid: A-2\ntitle: x: y\nstatus: todo\n---\n' });
  try {
    const brief = await projectBrief(p.root, p.files);
    assert.match(brief, /PROJECT\.md: none yet/);
    assert.match(brief, /1 diagnostics \(run tasks validate\)/);
    assert.match(brief, /Ready now: unavailable/); assert.doesNotMatch(brief, /- A-1/);
  } finally { await p.done(); }
});

test('a long PROJECT.md and a long board stay bounded', async () => {
  const files: Record<string, string> = { 'PROJECT.md': 'x'.repeat(50_000) };
  for (let i = 1; i <= 40; i++) files[`T-${String(i).padStart(3, '0')}.md`] = task(`T-${String(i).padStart(3, '0')}`);
  const p = await project(files);
  try {
    const brief = await projectBrief(p.root, p.files);
    assert.ok(brief.length < 9000, `brief is ${brief.length} chars`);
    assert.match(brief, /truncated; read the file for the rest/);
    assert.equal(brief.split('\n').filter(l => /^- T-\d+/.test(l)).length, 10); // ready list capped at 10
  } finally { await p.done(); }
});

test('the rules name the commands the agent must use and the human-decision rule', () => {
  const rules = pmRules('node /x/cli.js');
  for (const needle of ['node /x/cli.js tasks', 'claim', 'validate', 'never invent IDs', 'needs decision', 'PROJECT.md']) assert.ok(rules.includes(needle), needle);
  assert.ok(rules.length < 2000, `rules are ${rules.length} chars`);
});
