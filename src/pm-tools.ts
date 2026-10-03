import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { ApiError, ProjectFiles } from './project-files.js';
import { taskReadiness } from './task-readiness.js';
import { parseTask, type Task } from './tasks.js';

// Small, scriptable operations an AI project manager needs to change the board safely: claim, new, validate.
// They never decide anything; they only make the change atomic, unique and checked.

const assigneePattern = /^(human|agent):[^\s:]+$/u;
export class ToolError extends Error {}

// A cross-process lock held only for the duration of one claim. Kept in the state directory beside the project, never inside it.
async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const dir = join(dirname(root), '.olav-tasks-state', basename(root), 'locks');
  await mkdir(dir, { recursive: true });
  const lock = join(dir, 'tasks.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const handle = await open(lock, 'wx');
      await handle.writeFile(`${process.pid} ${new Date().toISOString()}`); await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A lock older than 30 s belongs to a process that died.
      const age = Date.now() - (await stat(lock).then(info => info.mtimeMs, () => Date.now()));
      if (age > 30_000) { await unlink(lock).catch(() => undefined); continue; }
      if (Date.now() > deadline) throw new ToolError('Another claim is in progress; try again.');
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  }
  try { return await operation(); } finally { await unlink(lock).catch(() => undefined); }
}

const reason = (task: Task, byId: Map<string, Task>, tasks: Task[]) => {
  if (task.status !== 'todo') return `status is ${task.status}`;
  if (task.blocked_by) return `blocked: ${task.blocked_by}`;
  const open = task.depends_on.filter(id => byId.get(id)?.status !== 'done');
  if (open.length) return `waiting for ${open.join(', ')}`;
  const children = tasks.filter(item => item.parent === task.id && item.status !== 'done').map(item => item.id);
  if (children.length) return `child tasks not done: ${children.join(', ')}`;
  return 'not ready';
};

/** Claim a ready task: status -> in-progress and assignee set in one write. Idempotent for the same assignee; fails if anyone else holds it. */
export async function claimTask(root: string, id: string, assignee: string) {
  if (!assigneePattern.test(assignee)) throw new ToolError('assignee must be human:<id> or agent:<id> (no whitespace or colon in the id).');
  return withLock(root, async () => {
    const files = new ProjectFiles(root);
    const listing = await files.tasks();
    const readiness = taskReadiness(listing);
    if (!readiness.complete) throw new ToolError(`Task scan or graph is incomplete (${readiness.diagnostics.length} diagnostics${listing.truncated ? ', truncated' : ''}); run tasks validate and fix it first.`);
    const task = listing.tasks.find(item => item.id === id);
    if (!task) throw new ToolError(`No task with ID ${id}.`);
    if (task.status === 'in-progress' && task.assignee === assignee) return { id, path: task.path, status: 'in-progress' as const, assignee, already: true };
    if (task.status === 'in-progress') throw new ToolError(`${id} is already claimed by ${task.assignee ?? 'someone'}.`);
    if (task.assignee && task.assignee !== assignee) throw new ToolError(`${id} is assigned to ${task.assignee}.`);
    if (!readiness.tasks.some(item => item.id === id)) throw new ToolError(`${id} is not ready: ${reason(task, new Map(listing.tasks.map(item => [item.id, item])), listing.tasks)}.`);
    const done = await files.claim(task.path, assignee, task.version);
    return { id, path: done.path, status: 'in-progress' as const, assignee, already: false, version: done.version };
  });
}

export type NewTaskOptions = { title: string; priority?: string; depends?: string[]; parent?: string; dir?: string; prefix?: string; body?: string };

/** Create a task with the next free ID. The file is created exclusively, so concurrent creators can never share an ID. */
export async function newTask(root: string, options: NewTaskOptions) {
  const title = options.title?.trim();
  if (!title) throw new ToolError('A non-empty title is required.');
  if (options.priority !== undefined && !['P0', 'P1', 'P2'].includes(options.priority)) throw new ToolError('priority must be P0, P1, or P2.');
  const files = new ProjectFiles(root);
  const listing = await files.tasks();
  const known = new Set(listing.tasks.map(task => task.id));
  for (const dependency of options.depends ?? []) if (!known.has(dependency)) throw new ToolError(`Unknown dependency: ${dependency}.`);
  if (options.parent && !known.has(options.parent)) throw new ToolError(`Unknown parent: ${options.parent}.`);
  const numbered = listing.tasks.map(task => /^(.+)-(\d+)$/.exec(task.id)).filter((match): match is RegExpExecArray => !!match);
  const counts = new Map<string, number>();
  for (const match of numbered) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  const prefix = options.prefix ?? [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'T';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(prefix)) throw new ToolError('prefix may contain letters, digits, dot, underscore and dash.');
  const same = numbered.filter(match => match[1] === prefix);
  let next = Math.max(0, ...same.map(match => Number(match[2]))) + 1;
  const width = Math.max(3, ...same.map(match => match[2].length));
  const dirs = new Map<string, number>();
  for (const task of listing.tasks) { const dir = dirname(task.path); dirs.set(dir, (dirs.get(dir) ?? 0) + 1); }
  const dir = options.dir ?? [...dirs].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'backlog/tasks';
  const target = dir === '.' ? '' : dir;
  // Create each directory level through ProjectFiles so symlinks and escapes are rejected the same way as everywhere else.
  let built = '';
  for (const part of target.split('/').filter(Boolean)) {
    built = built ? `${built}/${part}` : part;
    await files.directory(built).catch(error => { if (!(error instanceof ApiError) || (error.status !== 409 && !/exist/i.test(error.message))) throw error; });
  }
  const quote = (value: string) => JSON.stringify(value); // always quoted: titles with colons or backticks stay valid YAML
  for (let attempt = 0; attempt < 8; attempt++, next++) {
    const id = `${prefix}-${String(next).padStart(width, '0')}`;
    if (known.has(id)) continue;
    const front = ['---', 'schema: olav.tasks/v1', `id: ${quote(id)}`, `title: ${quote(title)}`, 'status: todo',
      ...(options.priority ? [`priority: ${options.priority}`] : []),
      ...(options.parent ? [`parent: ${quote(options.parent)}`] : []),
      `depends_on: [${(options.depends ?? []).map(quote).join(', ')}]`, '---'].join('\n');
    const content = `${front}\n\n${options.body?.trim() ? `${options.body.trim()}\n` : '## Goal\n\n\n## Acceptance criteria\n\n- \n'}`;
    const path = target ? `${target}/${id}.md` : `${id}.md`;
    if (!parseTask(content, path, 'v').task) throw new ToolError('Generated task file did not validate.');
    try { const created = await files.save(path, content, null); return { id, path: created.path, version: created.version }; }
    catch (error) { if (error instanceof ApiError && error.status === 409) continue; throw error; }
  }
  throw new ToolError('Could not allocate a free task ID; try again.');
}

/** Everything the board would flag: unreadable frontmatter, duplicate IDs, missing or cyclic dependencies and parents, a truncated scan. */
export async function validateProject(root: string) {
  const listing = await new ProjectFiles(root).tasks();
  const readiness = taskReadiness(listing);
  return { ok: readiness.diagnostics.length === 0 && !listing.truncated, tasks: listing.tasks.length, truncated: listing.truncated, diagnostics: readiness.diagnostics };
}
