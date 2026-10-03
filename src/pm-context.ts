import type { ProjectFiles } from './project-files.js';
import { taskReadiness } from './task-readiness.js';

// What a new conversation starts with, so the agent acts as the project manager instead of a generic chat.
// The rules are static (cacheable as a system prompt); the brief changes with the project and goes into the first message only.

export const pmRules = (cli: string) => `You are the project manager of the project in the current directory, working through conversation. People do not edit the board by hand: you do, and you answer for it.
- Tasks are Markdown files with \`schema: olav.tasks/v1\` frontmatter. Use the CLI \`${cli} tasks ...\` on the project directory: \`ready <dir> --json\` before proposing work; \`claim <dir> <ID> --as agent:<you>\` before starting a task; \`new <dir> --title ...\` to create one (never invent IDs); \`validate <dir>\` after any edit to task files, and fix what it reports; \`digest <dir>\` gives the weekly picture (what needs a person, overdue, stale, critical path) for status reports.
- Change status only on facts. Set \`done\` only after the acceptance criteria are verified, and record the evidence (what you ran, the result, changed paths or commit) in the task body.
- Do not decide for the human. When the choice is theirs (scope, priorities, anything irreversible), set \`blocked_by: "needs decision: ..."\` on the task, say so plainly, and ask. At the start of a conversation, tell them first what is waiting on them.
- Keep changes small and say exactly which files you changed. PROJECT.md (if present) holds the goals, priorities, definition of done and working agreements; follow it and keep its decision log current.`;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}\n… (truncated; read the file for the rest)` : text);
const line = (id: string, detail: string, title: string) => `- ${id}${detail ? ` (${detail})` : ''}: ${title}`;

/** A bounded snapshot: PROJECT.md plus a board summary. Best effort; the caller ignores failures. */
export async function projectBrief(root: string, files: ProjectFiles): Promise<string> {
  const project = await files.read('PROJECT.md').then(file => clip(file.content.trim(), 6000), () => undefined);
  const listing = await files.tasks();
  const readiness = taskReadiness(listing);
  const count = (status: string) => listing.tasks.filter(task => task.status === status).length;
  const inProgress = listing.tasks.filter(task => task.status === 'in-progress');
  const blocked = listing.tasks.filter(task => task.blocked_by && task.status !== 'done');
  const parts = [
    `Project directory: ${root}`,
    project ? `PROJECT.md:\n${project}` : 'PROJECT.md: none yet. If the user wants one, create it with their goals, priorities, definition of done and working agreements.',
    `Board: ${listing.tasks.length} tasks (todo ${count('todo')}, in-progress ${count('in-progress')}, done ${count('done')}); ${readiness.diagnostics.length} diagnostics${readiness.diagnostics.length ? ' (run tasks validate)' : ''}.`,
    inProgress.length ? `In progress:\n${inProgress.slice(0, 10).map(task => line(task.id, task.assignee ?? 'unassigned', task.title)).join('\n')}` : '',
    readiness.complete ? `Ready now:\n${readiness.tasks.slice(0, 10).map(task => line(task.id, task.priority ?? '', task.title)).join('\n') || '- none'}` : 'Ready now: unavailable until the diagnostics above are fixed.',
    blocked.length ? `Waiting on a person or a decision:\n${blocked.slice(0, 8).map(task => line(task.id, '', clip(task.blocked_by!, 160))).join('\n')}` : '',
  ].filter(Boolean);
  return `<project-context>\n${parts.join('\n\n')}\n</project-context>`;
}
