import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { taskReadiness, type TaskListing } from './task-readiness.js';
import type { Task } from './tasks.js';

const git = promisify(execFile);
const day = 86_400_000;

/** When a task file last changed: the last commit that touched it, else its modification time. */
export async function lastActivity(root: string, task: Task): Promise<Date | undefined> {
  try {
    const { stdout } = await git('git', ['log', '-1', '--format=%cI', '--', task.path], { cwd: root, timeout: 3000 });
    if (stdout.trim()) return new Date(stdout.trim());
  } catch { /* not a git repository, or git is unavailable */ }
  return stat(join(root, task.path)).then(info => info.mtime, () => undefined);
}

export type Digest = ReturnType<typeof buildDigest> extends Promise<infer T> ? T : never;

const localDay = (date: Date) => date.toLocaleDateString('sv-SE');
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / day);

/** The picture an AI project manager reports from: what needs a human, what is late or stale, progress, and the longest chain of open work. */
export async function buildDigest(root: string, listing: TaskListing, options: { now?: Date; staleDays?: number; activity?: (task: Task) => Promise<Date | undefined> } = {}) {
  const now = options.now ?? new Date();
  const staleDays = options.staleDays ?? 7;
  const activity = options.activity ?? (task => lastActivity(root, task));
  const readiness = taskReadiness(listing);
  const tasks = listing.tasks;
  const today = localDay(now);
  const open = tasks.filter(task => task.status !== 'done');
  const byId = new Map(tasks.map(task => [task.id, task]));

  const inProgress = await Promise.all(tasks.filter(task => task.status === 'in-progress').map(async task => {
    const at = await activity(task);
    return { id: task.id, title: task.title, assignee: task.assignee ?? null, days_idle: at ? Math.max(0, Math.floor((now.getTime() - at.getTime()) / day)) : null };
  }));

  // Parent progress counts direct children only.
  const parents = [...new Set(tasks.filter(task => task.parent).map(task => task.parent!))].map(id => {
    const children = tasks.filter(task => task.parent === id);
    return { id, title: byId.get(id)?.title ?? '(missing)', done: children.filter(child => child.status === 'done').length, total: children.length };
  }).filter(parent => parent.done < parent.total);

  // Longest chain of open tasks by depends_on. Only meaningful on an acyclic graph, so skip it when the board has diagnostics.
  let critical: { length: number; ids: string[] } = { length: 0, ids: [] };
  if (readiness.complete) {
    const memo = new Map<string, string[]>();
    const chain = (task: Task): string[] => {
      const known = memo.get(task.id); if (known) return known;
      let best: string[] = [];
      for (const dependency of task.depends_on) {
        const next = byId.get(dependency);
        if (!next || next.status === 'done') continue;
        const candidate = chain(next);
        if (candidate.length > best.length || (candidate.length === best.length && candidate[candidate.length - 1] < best[best.length - 1])) best = candidate;
      }
      const result = [...best, task.id]; memo.set(task.id, result); return result;
    };
    for (const task of open) { const result = chain(task); if (result.length > critical.length) critical = { length: result.length, ids: result }; }
  }

  return {
    generated: now.toISOString(),
    complete: readiness.complete,
    diagnostics: readiness.diagnostics,
    counts: { todo: tasks.filter(t => t.status === 'todo').length, 'in-progress': inProgress.length, done: tasks.filter(t => t.status === 'done').length },
    decisions: open.filter(task => task.blocked_by).map(task => ({ id: task.id, title: task.title, waiting_on: task.blocked_by! })),
    overdue: open.filter(task => task.end_date && task.end_date < today).map(task => ({ id: task.id, title: task.title, end_date: task.end_date!, days_late: daysBetween(task.end_date!, today) })),
    stale: inProgress.filter(item => item.days_idle !== null && item.days_idle >= staleDays),
    in_progress: inProgress,
    ready: readiness.tasks.slice(0, 10).map(task => ({ id: task.id, title: task.title, priority: task.priority ?? null })),
    parents,
    critical_path: critical,
    stale_days: staleDays,
  };
}

export function renderDigest(d: Awaited<ReturnType<typeof buildDigest>>) {
  const clip = (text: string, max = 90) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
  const out: string[] = [`# Project digest (${d.generated.slice(0, 10)})`, '', `${d.counts.todo + d.counts['in-progress'] + d.counts.done} tasks: ${d.counts.todo} todo, ${d.counts['in-progress']} in progress, ${d.counts.done} done.`];
  if (d.diagnostics.length) out.push('', `## The board has ${d.diagnostics.length} diagnostics`, 'Fix these first (run tasks validate); ready work and the critical path are not reliable until then.', ...d.diagnostics.slice(0, 10).map(x => `- ${x.path}: ${x.message}`));
  const section = (title: string, rows: string[]) => { if (rows.length) out.push('', `## ${title}`, ...rows); };
  section('Waiting on a person', d.decisions.map(x => `- ${x.id} ${clip(x.title)}: ${clip(x.waiting_on, 160)}`));
  section('Overdue', d.overdue.map(x => `- ${x.id} ${clip(x.title)}: ended ${x.end_date}, ${x.days_late} day${x.days_late === 1 ? '' : 's'} late`));
  section(`Stale (in progress, untouched for ${d.stale_days}+ days)`, d.stale.map(x => `- ${x.id} ${clip(x.title)}: ${x.assignee ?? 'unassigned'}, ${x.days_idle} days idle`));
  section('In progress', d.in_progress.map(x => `- ${x.id} ${clip(x.title)}: ${x.assignee ?? 'unassigned'}${x.days_idle === null ? '' : `, last change ${x.days_idle}d ago`}`));
  section('Ready now', d.ready.map(x => `- ${x.id}${x.priority ? ` (${x.priority})` : ''} ${clip(x.title)}`));
  section('Parent progress', d.parents.map(x => `- ${x.id} ${clip(x.title)}: ${x.done}/${x.total} children done`));
  if (d.critical_path.length > 1) out.push('', '## Critical path', `${d.critical_path.length} open tasks in sequence: ${d.critical_path.ids.join(' → ')}`);
  if (out.length === 3) out.push('', 'Nothing needs attention.');
  return out.join('\n');
}
