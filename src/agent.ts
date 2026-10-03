import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { ApiError, type ProjectFiles } from './project-files.js';

const git = promisify(execFile);
const run_git = (cwd: string, ...args: string[]) => git('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout.trim());
// One run per task. State lives outside the project (<parent>/.olav-tasks-state/<project>/) so it never pollutes the repo.
export type AgentEvent = { seq: number; type: 'user' | 'text' | 'tool' | 'permission' | 'result' | 'error'; text: string; at: string };
// activity: running = turn in flight, blocked = waiting on a permission decision, idle = turn done, awaiting next message.
export type RunStatus = 'running' | 'blocked' | 'idle' | 'failed' | 'stopped';
type Pending = { id: string; tool: string; resolve: (allow: boolean) => void };
type Run = { taskId: string; path: string; agent: string; status: RunStatus; sessionId?: string; events: AgentEvent[]; workdir: string; branch?: string; base?: string; accepted?: boolean; pending?: Pending; abort: AbortController };
const saved = ['taskId', 'path', 'agent', 'status', 'sessionId', 'events', 'workdir', 'branch', 'base', 'accepted'] as const;
export type TurnOptions = { prompt: string; cwd: string; resume?: string; signal: AbortSignal; canUseTool: (tool: string, input: Record<string, unknown>) => Promise<boolean> };
export type Turn = (options: TurnOptions) => AsyncIterable<any>;

// ponytail: Claude only; add a Codex/pi Turn with the same shape when a second agent is needed.
export const claudeTurn: Turn = async function* ({ prompt, cwd, resume, signal, canUseTool }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort(), { once: true });
  yield* query({
    prompt,
    options: {
      cwd, abortController, ...(resume ? { resume } : {}), permissionMode: 'default', permissionPrompts: 'host',
      canUseTool: async (tool, input) => (await canUseTool(tool, input)) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied in Olav Tasks.' },
    },
  });
};

export class AgentRuns {
  private runs = new Map<string, Run>();
  private state: string;
  constructor(private files: ProjectFiles, private root: string, private turn: Turn = claudeTurn) {
    this.state = join(dirname(root), '.olav-tasks-state', basename(root));
    const dir = join(this.state, 'runs');
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter(file => file.endsWith('.json'))) {
      try {
        const run = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Run;
        // A run that was in flight when the server stopped cannot continue its turn; it can still be resumed by message.
        if (run.status === 'running' || run.status === 'blocked') run.status = 'stopped';
        this.runs.set(run.taskId, { ...run, abort: new AbortController() });
      } catch { /* ignore unreadable run file */ }
    }
  }
  list() { return [...this.runs.values()].map(({ taskId, agent, status, branch, accepted }) => ({ taskId, agent, status, ...(branch ? { branch } : {}), ...(accepted ? { accepted } : {}) })); }
  get(taskId: string, since = 0) {
    const run = this.run(taskId);
    return { taskId, agent: run.agent, status: run.status, branch: run.branch, isolated: !!run.branch, accepted: !!run.accepted, events: run.events.filter(event => event.seq > since), ...(run.pending ? { pending: { id: run.pending.id, tool: run.pending.tool } } : {}) };
  }
  async start(path: unknown) {
    if (typeof path !== 'string') throw new ApiError(400, 'path must be text.');
    const board = await this.files.tasks();
    const task = board.tasks.find(item => item.path === path);
    if (!task) throw new ApiError(404, 'Task not found.');
    if (this.runs.get(task.id)?.status === 'running' || this.runs.get(task.id)?.status === 'blocked') throw new ApiError(409, 'This task already has an active run.');
    const body = (await this.files.read(path)).content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
    if (task.status === 'todo') await this.files.updateStatus(path, 'in-progress', task.version).catch(() => undefined);
    const run: Run = { taskId: task.id, path, agent: 'claude', status: 'running', events: [], workdir: this.root, abort: new AbortController() };
    await this.isolate(run);
    this.runs.set(task.id, run);
    this.go(run, `Work on Olav Tasks task ${task.id}: ${task.title}\n\n${body}\n\nImplement it in this project and verify against the acceptance criteria. Do not mark the task done; a human reviews and sets status.`);
    return this.get(task.id);
  }
  send(taskId: unknown, text: unknown) {
    const run = this.run(taskId);
    if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'text must be nonempty.');
    if (run.status === 'running' || run.status === 'blocked') throw new ApiError(409, 'A turn is already in progress.');
    run.abort = new AbortController();
    run.status = 'running';
    this.go(run, text.trim());
    return this.get(run.taskId);
  }
  permission(taskId: unknown, id: unknown, allow: unknown) {
    const run = this.run(taskId);
    if (!run.pending || run.pending.id !== id || typeof allow !== 'boolean') throw new ApiError(409, 'No matching pending permission.');
    run.pending.resolve(allow);
    return this.get(run.taskId);
  }
  stop(taskId: unknown) {
    const run = this.run(taskId);
    run.abort.abort();
    run.pending?.resolve(false);
    return this.get(run.taskId);
  }
  // Each task gets its own worktree and branch off the current HEAD. Not a git repo: work in place (isolated=false).
  private async isolate(run: Run) {
    try {
      const safe = run.taskId.replace(/[^A-Za-z0-9._-]/g, '_');
      const dir = join(this.state, 'worktrees', safe);
      const branch = `agent/${safe}`;
      if (!existsSync(dir)) {
        mkdirSync(dirname(dir), { recursive: true });
        const exists = await run_git(this.root, 'branch', '--list', branch);
        await run_git(this.root, 'worktree', 'add', ...(exists ? [dir, branch] : ['-b', branch, dir]));
      }
      run.base = await run_git(this.root, 'merge-base', 'HEAD', branch).catch(() => run_git(this.root, 'rev-parse', 'HEAD'));
      run.workdir = dir; run.branch = branch;
    } catch { /* not a git repo or worktree unavailable */ }
  }
  async diff(taskId: unknown) {
    const run = this.run(taskId);
    if (!run.branch || !run.base) throw new ApiError(409, 'This run is not isolated in a worktree, so there is no branch diff.');
    await run_git(run.workdir, 'add', '-N', '.');
    const [stat, patch] = await Promise.all([run_git(run.workdir, 'diff', '--stat', run.base), run_git(run.workdir, 'diff', run.base)]);
    return { branch: run.branch, stat, patch: patch.slice(0, 200_000), truncated: patch.length > 200_000 };
  }
  // Accept = a human decided the work meets the acceptance criteria. Only this sets the task to done; merging the branch stays a manual step.
  async accept(taskId: unknown) {
    const run = this.run(taskId);
    if (run.status === 'running' || run.status === 'blocked') throw new ApiError(409, 'Stop or finish the current turn before accepting.');
    const task = (await this.files.tasks()).tasks.find(item => item.id === run.taskId);
    if (!task) throw new ApiError(404, 'Task not found.');
    if (task.status !== 'done') await this.files.updateStatus(run.path, 'done', task.version);
    run.accepted = true; this.save(run);
    return this.get(run.taskId);
  }
  private save(run: Run) {
    try {
      mkdirSync(join(this.state, 'runs'), { recursive: true });
      writeFileSync(join(this.state, 'runs', `${run.taskId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`), JSON.stringify(Object.fromEntries(saved.map(key => [key, run[key]]))));
    } catch { /* persistence is best effort */ }
  }
  private run(taskId: unknown) {
    const run = typeof taskId === 'string' ? this.runs.get(taskId) : undefined;
    if (!run) throw new ApiError(404, 'No run for this task.');
    return run;
  }
  private push(run: Run, type: AgentEvent['type'], text: string) { run.events.push({ seq: run.events.length + 1, type, text, at: new Date().toISOString() }); this.save(run); }
  private go(run: Run, prompt: string) {
    this.push(run, 'user', prompt);
    void (async () => {
      try {
        for await (const message of this.turn({
          prompt, cwd: run.workdir, resume: run.sessionId, signal: run.abort.signal,
          canUseTool: (tool, input) => new Promise<boolean>(resolve => {
            const id = randomUUID();
            run.pending = { id, tool, resolve: allow => { run.pending = undefined; run.status = 'running'; resolve(allow); } };
            run.status = 'blocked';
            this.push(run, 'permission', `${tool} ${JSON.stringify(input).slice(0, 500)}`);
          }),
        })) {
          if (message.session_id) run.sessionId = message.session_id;
          if (message.type === 'assistant') for (const block of message.message?.content ?? []) {
            if (block.type === 'text' && block.text) this.push(run, 'text', block.text);
            else if (block.type === 'tool_use') this.push(run, 'tool', `${block.name} ${JSON.stringify(block.input).slice(0, 300)}`);
          } else if (message.type === 'result') this.push(run, 'result', message.result ?? message.subtype ?? 'done');
        }
        run.status = run.abort.signal.aborted ? 'stopped' : 'idle'; this.save(run);
      } catch (error) {
        run.status = run.abort.signal.aborted ? 'stopped' : 'failed';
        if (run.status === 'failed') this.push(run, 'error', error instanceof Error ? error.message : String(error)); else this.save(run);
      }
    })();
  }
}
