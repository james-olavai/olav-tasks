import type { Task } from './tasks.js';

export type TaskDiagnostic = { path: string; message: string };
export type TaskListing = { tasks: Task[]; diagnostics: TaskDiagnostic[]; truncated: boolean; revision: string };

const order = (a: Task, b: Task) => (a.priority ?? 'P2').localeCompare(b.priority ?? 'P2') || a.id.localeCompare(b.id, 'en', { numeric: true }) || a.path.localeCompare(b.path, 'en');

/** A read-only snapshot. Any incomplete or invalid task graph fails closed. */
export function taskReadiness(listing: TaskListing) {
  const tasks = [...listing.tasks].sort(order);
  const diagnostics = [...listing.diagnostics];
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) diagnostics.push({ path: task.path, message: `Duplicate task ID: ${task.id}` });
    byId.set(task.id, task);
  }
  for (const task of tasks) {
    for (const dependency of task.depends_on) {
      if (!byId.has(dependency)) diagnostics.push({ path: task.path, message: `Missing dependency: ${dependency}` });
    }
    if (task.parent && !byId.has(task.parent)) diagnostics.push({ path: task.path, message: `Missing parent: ${task.parent}` });
  }
  const visit = (relation: 'depends_on' | 'parent') => {
    const state = new Map<string, number>();
    const neighbors = (task: Task) => relation === 'depends_on' ? task.depends_on : task.parent ? [task.parent] : [];
    for (const task of tasks) {
      if (state.has(task.id)) continue;
      state.set(task.id, 1);
      const stack: { id: string; next: string[]; index: number }[] = [{ id: task.id, next: neighbors(task), index: 0 }];
      while (stack.length) {
        const frame = stack[stack.length - 1];
        if (frame.index === frame.next.length) { state.set(frame.id, 2); stack.pop(); continue; }
        const adjacent = frame.next[frame.index++];
        const target = byId.get(adjacent);
        if (!target) continue;
        if (state.get(adjacent) === 1) { diagnostics.push({ path: target.path, message: `${relation} cycle at ${adjacent}` }); continue; }
        if (state.get(adjacent) === 2) continue;
        state.set(adjacent, 1);
        stack.push({ id: adjacent, next: neighbors(target), index: 0 });
      }
    }
  };
  visit('depends_on');
  visit('parent');
  const parentsWithIncompleteChildren = new Set(tasks.filter(task => task.parent && task.status !== 'done').map(task => task.parent!));
  const excluded = tasks.filter(task => task.status !== 'todo' || Boolean(task.blocked_by) || task.depends_on.some(id => byId.get(id)?.status !== 'done') || parentsWithIncompleteChildren.has(task.id));
  const complete = !listing.truncated && diagnostics.length === 0;
  return { tasks: complete ? tasks.filter(task => !excluded.includes(task)) : [], excluded: complete ? excluded : tasks, diagnostics, revision: listing.revision, complete };
}
