import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { activity, activityDiff } from '../src/activity.js';

async function repo() {
  const parent = await mkdtemp(join(tmpdir(), 'activity-')); const root = join(parent, 'proj'); await mkdir(root);
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=Tester', ...args], { cwd: root });
  git('init', '-q');
  return { parent, root, git, done: () => rm(parent, { recursive: true, force: true }) };
}

test('commits and uncommitted changes are listed, and diffs are produced only for listed paths', async () => {
  const r = await repo();
  try {
    await writeFile(join(r.root, 'a.md'), 'one\n'); await writeFile(join(r.root, 'b.md'), 'keep\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'first');
    await writeFile(join(r.root, 'a.md'), 'one\ntwo\n'); r.git('commit', '-qam', 'second: add two');
    await writeFile(join(r.root, 'a.md'), 'one\ntwo\nthree\n');          // uncommitted edit
    await writeFile(join(r.root, 'new.md'), 'fresh\n');                   // untracked
    const view = await activity(r.root);
    assert.equal(view.git, true); if (!view.git) return;
    assert.deepEqual(view.commits.map(c => c.subject), ['second: add two', 'first']);
    assert.equal(view.commits[0].author, 'Tester'); assert.deepEqual(view.commits[0].files, [{ status: 'M', path: 'a.md' }]);
    assert.deepEqual(view.changes.map(c => [c.status, c.path]).sort(), [['?', 'new.md'], ['M', 'a.md']]);
    assert.match((await activityDiff(r.root, { path: 'a.md' })).diff, /\+three/);              // uncommitted
    assert.match((await activityDiff(r.root, { path: 'new.md' })).diff, /\+fresh/);            // untracked
    assert.match((await activityDiff(r.root, { path: 'a.md', commit: view.commits[0].hash })).diff, /\+two/);
    await assert.rejects(activityDiff(r.root, { path: 'b.md' }), /no uncommitted change/);     // not listed: refused
    await assert.rejects(activityDiff(r.root, { path: '../../etc/passwd' }), /no uncommitted change/);
    await assert.rejects(activityDiff(r.root, { path: 'a.md', commit: 'zzzz' }), /Invalid commit/);
    await assert.rejects(activityDiff(r.root, { path: 'b.md', commit: view.commits[0].hash }), /not part of a recent commit/);
  } finally { await r.done(); }
});

test('a project that is a subdirectory of a larger repository only shows its own paths, relative to itself', async () => {
  const r = await repo();
  try {
    await mkdir(join(r.root, 'inside')); await writeFile(join(r.root, 'outside.md'), 'x\n'); await writeFile(join(r.root, 'inside', 'p.md'), 'p\n');
    r.git('add', '-A'); r.git('commit', '-qm', 'both');
    await writeFile(join(r.root, 'outside.md'), 'y\n'); await writeFile(join(r.root, 'inside', 'p.md'), 'q\n');
    const view = await activity(join(r.root, 'inside'));
    assert.equal(view.git, true); if (!view.git) return;
    assert.deepEqual(view.changes, [{ status: 'M', path: 'p.md' }]);
    assert.deepEqual(view.commits[0].files, [{ status: 'A', path: 'p.md' }]);
    assert.match((await activityDiff(join(r.root, 'inside'), { path: 'p.md' })).diff, /\+q/);
  } finally { await r.done(); }
});

test('outside git there is no activity and no diff', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'activity-nogit-'));
  try { assert.deepEqual(await activity(parent), { git: false }); await assert.rejects(activityDiff(parent, { path: 'a.md' }), /not a git repository/); } finally { await rm(parent, { recursive: true, force: true }); }
});

test('a project with no commits yet still lists its untracked files', async () => {
  const r = await repo();
  try {
    await writeFile(join(r.root, 'a.md'), 'x\n');
    const view = await activity(r.root); assert.equal(view.git, true); if (!view.git) return;
    assert.deepEqual(view.commits, []); assert.deepEqual(view.changes, [{ status: '?', path: 'a.md' }]);
  } finally { await r.done(); }
});
