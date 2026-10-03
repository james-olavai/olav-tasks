import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ApiError, type ProjectFiles } from './project-files.js';

const git = promisify(execFile);
const run_git = (cwd: string, ...args: string[]) => git('git', args, { cwd, maxBuffer: 8 * 1024 * 1024 }).then(result => result.stdout.trim());
// One run per task. State lives outside the project (<parent>/.olav-tasks-state/<project>/) so it never pollutes the repo.
export type AgentEvent = { seq: number; type: 'user' | 'text' | 'tool' | 'permission' | 'result' | 'error' | 'check'; text: string; at: string; role?: string; model?: string };
// activity: running = turn in flight, blocked = waiting on a permission decision, idle = turn done, awaiting next message.
export type RunStatus = 'running' | 'blocked' | 'idle' | 'failed' | 'stopped';
type Pending = { id: string; tool: string; resolve: (allow: boolean) => void };
// Token/cost totals for a run. cost_usd is absent when the agent does not report it (unknown, not zero).
export type Usage = { cost_usd?: number; input: number; output: number; cache_read: number; cache_write: number; turns: number };
type Reported = { cost_usd?: number; input: number; output: number; cache_read: number; cache_write: number; cumulative: boolean };
// Result of the task's own check command, run by the server (not the agent) in the run's worktree.
export type CheckResult = { command: string; ok: boolean; exit: number | null; timedOut: boolean; ms: number; output: string; at: string };
type Run = { check?: CheckResult; spawned?: Map<string, string>; usage?: Usage; taskId: string; path: string; agent: string; status: RunStatus; sessionId?: string; events: AgentEvent[]; workdir: string; branch?: string; base?: string; model?: string; accepted?: boolean; cleaned?: boolean; pending?: Pending; abort: AbortController };
const saved = ['taskId', 'path', 'agent', 'status', 'sessionId', 'events', 'workdir', 'branch', 'base', 'model', 'accepted', 'cleaned', 'usage', 'check'] as const;
export type TurnOptions = { prompt: string; cwd: string; systemPrompt?: string; model?: string; resume?: string; signal: AbortSignal; canUseTool: (tool: string, input: Record<string, unknown>) => Promise<boolean> };
export type Turn = (options: TurnOptions) => AsyncIterable<any>;

// Optional hard limits from the environment; unset means no limit. OLAV_TASKS_MAX_BUDGET_USD / OLAV_TASKS_MAX_TURNS cap one turn.
// OLAV_TASKS_SETTING_SOURCES=project (or user,project,local; none = isolated) limits which settings/CLAUDE.md the agent loads; unset = SDK default (all).
const positive = (name: string) => { const value = Number(process.env[name]); return Number.isFinite(value) && value > 0 ? value : undefined; };
export const caps = () => {
  const budget = positive('OLAV_TASKS_MAX_BUDGET_USD'); const turns = positive('OLAV_TASKS_MAX_TURNS');
  const raw = process.env.OLAV_TASKS_SETTING_SOURCES?.trim();
  const sources = raw ? (raw === 'none' ? [] : raw.split(',').map(item => item.trim()).filter((item): item is 'user' | 'project' | 'local' => ['user', 'project', 'local'].includes(item))) : undefined;
  return { ...(budget ? { maxBudgetUsd: budget } : {}), ...(turns ? { maxTurns: turns } : {}), ...(sources ? { settingSources: sources } : {}) };
};
// Subagent roles the Claude coordinator may delegate to, each pinned to a tier and a tool allowlist. Models come from
// OLAV_TASKS_ROLE_MODELS='{"explorer":"…","implementer":"…","reviewer":"…"}' (defaults: haiku/sonnet/opus aliases).
// ponytail: reviewer gets Bash so it can run `git diff`/tests; every Bash call still goes through the human permission prompt.
export const roleAgents = () => {
  let custom: Record<string, string> = {};
  try { custom = JSON.parse(process.env.OLAV_TASKS_ROLE_MODELS ?? '{}'); } catch { /* ignore malformed */ }
  const model = (role: string, fallback: string) => (typeof custom[role] === 'string' && custom[role] ? custom[role] : fallback);
  return {
    explorer: { description: 'Read-only search of the repository. Use to locate code and evidence so the main agent does not read many files itself.', prompt: 'You search the repository and report concise findings with file paths and line numbers. Do not modify anything.', tools: ['Read', 'Grep', 'Glob'], model: model('explorer', 'haiku'), omitClaudeMd: true },
    implementer: { description: 'Implements one well-specified work package with settled interfaces and disjoint files.', prompt: 'You implement exactly the package you are given, run the affected checks, and report what changed and the raw results.', model: model('implementer', 'sonnet') },
    reviewer: { description: 'Independent read-only review of the actual diff and acceptance evidence. Never edits files.', prompt: 'You independently review the diff against the acceptance criteria. Do not edit files. Report failures with evidence, not opinions.', tools: ['Read', 'Grep', 'Glob', 'Bash'], model: model('reviewer', 'opus') },
  };
};
export const claudeTurn: Turn = async function* ({ prompt, cwd, systemPrompt, model, resume, signal, canUseTool }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const abortController = new AbortController();
  signal.addEventListener('abort', () => abortController.abort(), { once: true });
  // Claude reports the whole session's spend (including subagents) on each result; take the latest, do not sum.
  const reported = (m: any): Reported => {
    const models = Object.values<any>(m.modelUsage ?? {});
    const sum = (key: string) => models.reduce((total, item) => total + (item[key] ?? 0), 0);
    return { cost_usd: m.total_cost_usd, input: sum('inputTokens'), output: sum('outputTokens'), cache_read: sum('cacheReadInputTokens'), cache_write: sum('cacheCreationInputTokens'), cumulative: true };
  };
  for await (const message of query({
    prompt,
    options: {
      cwd, abortController, agents: roleAgents(), ...caps(), ...(systemPrompt ? { systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt } } : {}), ...(model ? { model } : {}), ...(resume ? { resume } : {}), permissionMode: 'default', permissionPrompts: 'host',
      canUseTool: async (tool, input) => (await canUseTool(tool, input)) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Denied in Olav Tasks.' },
    },
  })) yield message.type === 'result' ? { ...message, reported: reported(message) } : message;
};

// Codex SDK has no per-tool approval callback (it wraps non-interactive `codex exec`), so a Codex run never reaches `blocked`.
// Its safety boundary is the sandbox instead: writes only inside the task worktree, no network, never asks.
export const codexTurn: Turn = async function* ({ prompt, cwd, model, resume, signal }) {
  const { Codex } = await import('@openai/codex-sdk');
  const options = { workingDirectory: cwd, skipGitRepoCheck: true, sandboxMode: 'workspace-write', approvalPolicy: 'never', networkAccessEnabled: false, ...(model ? { model } : {}) } as const;
  const codex = new Codex();
  const thread = resume ? codex.resumeThread(resume, options) : codex.startThread(options);
  const { events } = await thread.runStreamed(prompt, { signal });
  // Normalize to the same message shape the Claude turn yields, so AgentRuns stays agent-agnostic.
  for await (const event of events) {
    if (event.type === 'thread.started') yield { session_id: event.thread_id };
    else if (event.type === 'item.completed') {
      const item = event.item;
      if (item.type === 'agent_message') yield { type: 'assistant', message: { content: [{ type: 'text', text: item.text }] } };
      else if (item.type === 'command_execution') yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: item.command, exit_code: item.exit_code } }] } };
      else if (item.type === 'file_change') yield { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Edit', input: { changes: item.changes } }] } };
      else if (item.type === 'error') yield { type: 'assistant', message: { content: [{ type: 'text', text: `error: ${item.message}` }] } };
    } else if (event.type === 'turn.completed') yield { type: 'result', result: 'ok', reported: { input: event.usage.input_tokens, output: event.usage.output_tokens, cache_read: event.usage.cached_input_tokens, cache_write: event.usage.cache_write_input_tokens, cumulative: false } satisfies Reported };
    else if (event.type === 'turn.failed') throw new Error(event.error.message);
    else if (event.type === 'error') throw new Error(event.message);
  }
};
export const defaultTurns: Record<string, Turn> = { claude: claudeTurn, codex: codexTurn };

// The bundled loop-dev skill, read once, becomes the Claude coordinator's rules. ponytail: Claude only; the Codex SDK exposes no system prompt.
const loopRules = (() => {
  try {
    const text = readFileSync(fileURLToPath(new URL('../skills/loop-dev/SKILL.md', import.meta.url)), 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    return `You are running inside Olav Tasks on one task, in its own git worktree. Follow this loop-dev skill as the coordinator, with these overrides: the repository's and the user's rules win; do not call the Jev scripts (no external routing is authorized); never edit the task file's status; you may delegate to the subagents explorer (read-only search), implementer (one work package) and reviewer (independent read-only review) only when the loop below says delegation pays; when the acceptance checks pass or you are blocked, stop and report what changed, the evidence, and any blocker, because a human accepts the work.\n\n${text}`;
  } catch { return undefined; }
})();

// Run a task's check command: `sh -c`, own process group so a timeout kills the whole tree, secrets stripped, output tail kept.
// The command comes from the task file in the project root, never from the worktree copy the agent can edit.
const secretEnv = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENROUTER_API_KEY'];
function runCheck(command: string, cwd: string, signal: AbortSignal): Promise<CheckResult> {
  const timeout = positive('OLAV_TASKS_CHECK_TIMEOUT_MS') ?? 120_000;
  const env = { ...process.env }; for (const name of secretEnv) delete env[name];
  const started = Date.now();
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', command], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; let timedOut = false;
    const take = (chunk: Buffer) => { output = (output + chunk.toString('utf8')).slice(-8000); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    const kill = () => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeout);
    signal.addEventListener('abort', kill, { once: true });
    const done = (exit: number | null) => { clearTimeout(timer); signal.removeEventListener('abort', kill); resolve({ command, ok: exit === 0 && !timedOut, exit, timedOut, ms: Date.now() - started, output, at: new Date().toISOString() }); };
    child.on('error', error => { output += String(error); done(null); });
    child.on('close', code => done(code));
  });
}

export class AgentRuns {
  private runs = new Map<string, Run>();
  private state: string;
  // Profile -> model ID. Claude defaults to the Claude Code aliases haiku/sonnet/opus; override or add codex with
  // OLAV_TASKS_MODELS='{"claude":{"fast":"…"},"codex":{"fast":"…"}}'. Codex has no default (model IDs are the user's). Only tasks with a model_profile are affected.
  private models: Record<string, Record<string, string>> = (() => {
    let custom: Record<string, Record<string, string>> = {};
    try { custom = JSON.parse(process.env.OLAV_TASKS_MODELS ?? '{}'); } catch { /* ignore malformed */ }
    return { ...custom, claude: { fast: 'haiku', balanced: 'sonnet', deep: 'opus', ...custom.claude } };
  })();
  constructor(private files: ProjectFiles, private root: string, private turns: Record<string, Turn> = defaultTurns) {
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
  list() { return [...this.runs.values()].map(({ taskId, agent, status, branch, accepted, usage }) => ({ taskId, agent, status, ...(usage ? { usage } : {}), ...(branch ? { branch } : {}), ...(accepted ? { accepted } : {}) })); }
  get(taskId: string, since = 0) {
    const run = this.run(taskId);
    return { taskId, agent: run.agent, status: run.status, model: run.model ?? null, usage: run.usage ?? null, check: run.check ?? null, branch: run.branch, isolated: !!run.branch, accepted: !!run.accepted, cleaned: !!run.cleaned, events: run.events.filter(event => event.seq > since), ...(run.pending ? { pending: { id: run.pending.id, tool: run.pending.tool } } : {}) };
  }
  // Ready = todo, every dependency exists and is done, no active run. Starting is always an explicit user action.
  async ready() {
    const { tasks } = await this.files.tasks();
    const done = new Set(tasks.filter(task => task.status === 'done').map(task => task.id));
    const known = new Set(tasks.map(task => task.id));
    return tasks.filter(task => task.status === 'todo' && !task.assignee?.startsWith('human:') && task.depends_on.every(id => known.has(id) && done.has(id)) && !this.active(task.id))
      .sort((a, b) => (a.priority ?? 'P3').localeCompare(b.priority ?? 'P3') || a.id.localeCompare(b.id, 'en', { numeric: true }));
  }
  // ponytail: fixed cap so a click cannot fan out unbounded agents/cost; make it a setting if it needs tuning.
  async startReady(paths?: unknown) {
    if (paths !== undefined && !(Array.isArray(paths) && paths.every(item => typeof item === 'string'))) throw new ApiError(400, 'paths must be a list of text.');
    const max = Number(process.env.OLAV_TASKS_MAX_RUNS ?? 2) || 2;
    const started: string[] = []; const skipped: { id: string; reason: string }[] = [];
    for (const task of (await this.ready()).filter(item => !paths || paths.includes(item.path))) {
      if ([...this.runs.values()].filter(run => run.status === 'running' || run.status === 'blocked').length >= max) { skipped.push({ id: task.id, reason: `已达并行上限 ${max}` }); continue; }
      try { await this.start(task.path); started.push(task.id); } catch (error) { skipped.push({ id: task.id, reason: error instanceof Error ? error.message : String(error) }); }
    }
    return { started, skipped, max };
  }
  private active(taskId: string) { const status = this.runs.get(taskId)?.status; return status === 'running' || status === 'blocked'; }
  async start(path: unknown, requested?: unknown) {
    if (typeof path !== 'string') throw new ApiError(400, 'path must be text.');
    if (requested !== undefined && (typeof requested !== 'string' || !this.turns[requested])) throw new ApiError(400, `agent must be one of: ${Object.keys(this.turns).join(', ')}.`);
    const board = await this.files.tasks();
    const task = board.tasks.find(item => item.path === path);
    if (!task) throw new ApiError(404, 'Task not found.');
    if (this.runs.get(task.id)?.status === 'running' || this.runs.get(task.id)?.status === 'blocked') throw new ApiError(409, 'This task already has an active run.');
    const body = (await this.files.read(path)).content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, '');
    let version = task.version;
    if (task.status === 'todo') version = (await this.files.updateStatus(path, 'in-progress', version).catch(() => undefined))?.version ?? version;
    // An explicit choice wins, then an `agent:<id>` assignee, then claude. A human assignee is never overwritten.
    const assigned = task.assignee?.startsWith('agent:') ? task.assignee.slice(6) : undefined;
    const agent = (requested as string | undefined) ?? (assigned && this.turns[assigned] ? assigned : 'claude');
    if (!task.assignee || (assigned && assigned !== agent)) await this.files.setMeta(path, 'assignee', `agent:${agent}`, version).catch(() => undefined);
    const run: Run = { taskId: task.id, path, agent, status: 'running', events: [], workdir: this.root, abort: new AbortController() };
    run.model = task.model_profile ? this.models[agent]?.[task.model_profile] : undefined;
    await this.isolate(run);
    this.runs.set(task.id, run);
    this.go(run, `Work on Olav Tasks task ${task.id}: ${task.title}\n\n${body}\n\nImplement it in this project and verify against the acceptance criteria.${task.check ? `\n\nCheck command (must exit 0; the server also runs it independently after your turn, in your worktree): ${task.check}` : ''} Do not mark the task done; a human reviews and sets status.`);
    return this.get(task.id);
  }
  send(taskId: unknown, text: unknown) {
    const run = this.run(taskId);
    if (typeof text !== 'string' || !text.trim()) throw new ApiError(400, 'text must be nonempty.');
    if (run.cleaned) throw new ApiError(409, 'The worktree was cleaned up; start a new run to continue.');
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
  // Run the task's check now. The result is evidence for the human gate: it never changes task status by itself.
  private async check(run: Run) {
    const task = (await this.files.tasks()).tasks.find(item => item.id === run.taskId);
    if (!task?.check) { run.check = undefined; return; }
    run.check = await runCheck(task.check, run.workdir, run.abort.signal);
    this.push(run, 'check', `${run.check.ok ? 'green' : run.check.timedOut ? 'red (timed out)' : `red (exit ${run.check.exit})`} · ${(run.check.ms / 1000).toFixed(1)}s · ${task.check}`);
  }
  async recheck(taskId: unknown) {
    const run = this.run(taskId);
    if (this.active(run.taskId)) throw new ApiError(409, 'A turn is in progress.');
    if (run.cleaned) throw new ApiError(409, 'The worktree was cleaned up.');
    run.abort = new AbortController();
    await this.check(run);
    this.save(run);
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
    // After cleanup the work lives only on the branch; compare against it. Before, include uncommitted and new files.
    if (!run.cleaned) await run_git(run.workdir, 'add', '-N', '.');
    const [cwd, target] = run.cleaned ? [this.root, [run.base, run.branch]] : [run.workdir, [run.base]];
    const [stat, patch] = await Promise.all([run_git(cwd, 'diff', '--stat', ...target), run_git(cwd, 'diff', ...target)]);
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
  // After acceptance: commit the worktree's work onto agent/<ID> and remove the worktree. The branch is kept; merging stays manual.
  async cleanup(taskId: unknown) {
    const run = this.run(taskId);
    if (!run.branch || run.cleaned) throw new ApiError(409, 'Nothing to clean up.');
    if (!run.accepted) throw new ApiError(409, 'Accept the work before cleaning up its worktree.');
    if (this.active(run.taskId)) throw new ApiError(409, 'Stop or finish the current turn first.');
    try {
      await run_git(run.workdir, 'add', '-A');
      const dirty = await run_git(run.workdir, 'status', '--porcelain');
      if (dirty) await run_git(run.workdir, '-c', 'user.name=olav-tasks agent', '-c', 'user.email=agent@olav-tasks.local', 'commit', '-q', '-m', `${run.taskId}: agent work (${run.agent})`);
      await run_git(this.root, 'worktree', 'remove', run.workdir);
    } catch (error) { throw new ApiError(409, `Cleanup failed; the worktree was left in place: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`); }
    run.cleaned = true; this.save(run);
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
  private record(run: Run, report: Reported) {
    const before = run.usage ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0 };
    const { cumulative, ...numbers } = report;
    run.usage = cumulative
      ? { ...numbers, turns: before.turns + 1 }
      : { ...(before.cost_usd !== undefined || numbers.cost_usd !== undefined ? { cost_usd: (before.cost_usd ?? 0) + (numbers.cost_usd ?? 0) } : {}), input: before.input + numbers.input, output: before.output + numbers.output, cache_read: before.cache_read + numbers.cache_read, cache_write: before.cache_write + numbers.cache_write, turns: before.turns + 1 };
  }
  private push(run: Run, type: AgentEvent['type'], text: string, who: { role?: string; model?: string } = {}) { run.events.push({ seq: run.events.length + 1, type, text, at: new Date().toISOString(), ...(who.role ? { role: who.role } : {}), ...(who.model ? { model: who.model } : {}) }); this.save(run); }
  private go(run: Run, prompt: string) {
    this.push(run, 'user', prompt);
    void (async () => {
      try {
        for await (const message of this.turns[run.agent]({
          prompt, cwd: run.workdir, model: run.model, systemPrompt: run.agent === 'claude' ? loopRules : undefined, resume: run.sessionId, signal: run.abort.signal,
          canUseTool: (tool, input) => new Promise<boolean>(resolve => {
            const id = randomUUID();
            run.pending = { id, tool, resolve: allow => { run.pending = undefined; run.status = 'running'; resolve(allow); } };
            run.status = 'blocked';
            this.push(run, 'permission', `${tool} ${JSON.stringify(input).slice(0, 500)}`);
          }),
        })) {
          if (message.session_id) run.sessionId = message.session_id;
          if (message.type === 'assistant') for (const block of message.message?.content ?? []) {
            // Subagent messages carry parent_tool_use_id; map it back to the role named when the main agent spawned it.
            run.spawned ??= new Map();
            const who = { role: message.parent_tool_use_id ? run.spawned.get(message.parent_tool_use_id) ?? 'subagent' : undefined, model: message.message?.model };
            if (block.type === 'text' && block.text) this.push(run, 'text', block.text, who);
            else if (block.type === 'tool_use') {
              if ((block.name === 'Agent' || block.name === 'Task') && typeof block.input?.subagent_type === 'string') run.spawned.set(block.id, block.input.subagent_type);
              this.push(run, 'tool', `${block.name} ${JSON.stringify(block.input).slice(0, 300)}`, who);
            }
          } else if (message.type === 'result') {
            if (message.reported) this.record(run, message.reported);
            // Error results (budget, turn limit, execution error) are shown as errors; the run stays resumable by message.
            if (typeof message.subtype === 'string' && message.subtype.startsWith('error')) this.push(run, 'error', message.subtype);
            else this.push(run, 'result', message.result ?? message.subtype ?? 'done');
          }
        }
        if (!run.abort.signal.aborted) await this.check(run).catch(error => this.push(run, 'error', `check could not run: ${error instanceof Error ? error.message : String(error)}`));
        run.status = run.abort.signal.aborted ? 'stopped' : 'idle'; this.save(run);
      } catch (error) {
        run.status = run.abort.signal.aborted ? 'stopped' : 'failed';
        if (run.status === 'failed') this.push(run, 'error', error instanceof Error ? error.message : String(error)); else this.save(run);
      }
    })();
  }
}
