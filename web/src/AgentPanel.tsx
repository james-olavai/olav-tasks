import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type AgentEvent = { seq: number; type: string; text: string; role?: string; model?: string };
type Diff = { branch: string; stat: string; patch: string; truncated: boolean };
type Usage = { cost_usd?: number; input: number; output: number; cache_read: number; cache_write: number; turns: number };
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// Cost is a client-side estimate and absent when the agent does not report it.
const usageText = (u: Usage) => `${u.cost_usd !== undefined ? `约 $${u.cost_usd.toFixed(2)} · ` : '费用未知 · '}输入 ${k(u.input)} · 输出 ${k(u.output)} · 缓存读 ${k(u.cache_read)} · ${u.turns} 回合`;
type Check = { command: string; ok: boolean; exit: number | null; timedOut: boolean; ms: number; output: string };
type Run = { check?: Check | null; cleaned?: boolean; usage?: Usage | null; model?: string | null; branch?: string; isolated?: boolean; accepted?: boolean; status: 'running' | 'blocked' | 'idle' | 'failed' | 'stopped'; agent: string; events: AgentEvent[]; pending?: { id: string; tool: string } };
const labels: Record<string, string> = { running: '运行中', blocked: '等待批准', idle: '等待下一条指令', failed: '失败', stopped: '已停止' };
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data as T;
}
export function AgentPanel({ taskId, path, version, profile }: { taskId: string; path: string; version: string; profile?: string }) {
  const [run, setRun] = useState<Run>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [diff, setDiff] = useState<Diff>();
  const act = (action: () => Promise<Run>) => action().then(next => { setRun(next); setError(''); }, (cause: Error) => setError(cause.message));
  useEffect(() => {
    let live = true; let seen = 0; let events: AgentEvent[] = [];
    setRun(undefined); setDiff(undefined);
    const poll = async () => {
      try {
        const next = await call<Run>(`run?task=${encodeURIComponent(taskId)}&since=${seen}`);
        events = [...events, ...next.events]; seen = events.at(-1)?.seq ?? seen;
        if (live) setRun({ ...next, events });
      } catch { /* no run yet */ }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { live = false; clearInterval(timer); };
  }, [taskId]);
  const busy = run?.status === 'running' || run?.status === 'blocked';
  return <section className="agent-panel" aria-label="开发 Agent">
    <h4>开发 Agent{run && <span className={`status-badge ${run.status}`}> {run.agent} · {labels[run.status]}{run.accepted ? ' · 已验收' : ''}</span>}{run?.usage && <span className="agent-branch" title="费用为 SDK 本地估算，非账单"> {usageText(run.usage)}</span>}{run?.branch && <code className="agent-branch"> {run.branch}{run.model ? ` · ${run.model}` : ''}</code>}</h4>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {!run && <div className="agent-review"><label>模型档位 <select value={profile ?? ''} onChange={event => { if (event.target.value) void fetch('/api/task-meta', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path, field: 'model_profile', value: event.target.value, version }) }).then(async response => { if (!response.ok) setError((await response.json()).error ?? '保存失败'); else setError(''); }); }}>
        <option value="">默认</option><option value="fast">fast</option><option value="balanced">balanced</option><option value="deep">deep</option></select></label>
      <Button size="sm" onClick={() => void act(() => call<Run>('start', { path, agent: 'claude' }))}>用 Claude 开始</Button>
      <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('start', { path, agent: 'codex' }))}>用 Codex 开始</Button>
      <span className="muted">Codex 无逐条批准：在只能写任务 worktree、禁网的沙箱内自动运行。档位对应的具体模型由 OLAV_TASKS_MODELS 配置，未配置则用默认模型。</span></div>}
    {run && <>
      <ol className="agent-log">{run.events.map(event => <li key={event.seq} className={`agent-${event.type}`}><strong>{event.role ? `${event.role}${event.model ? ` · ${event.model}` : ''}` : event.type}</strong> {event.text}</li>)}</ol>
      {run.pending && <div className="feedback warning" role="status">需要批准：{run.pending.tool}
        <Button size="sm" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: true }))}>允许</Button>
        <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: false }))}>拒绝</Button></div>}
      <form className="agent-input" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; void act(() => call<Run>('send', { task: taskId, text })).then(() => setText('')); }}>
        <input value={text} onChange={event => setText(event.target.value)} disabled={busy} placeholder="给 Agent 的下一条指令" aria-label="给 Agent 的指令"/>
        <Button size="sm" type="submit" disabled={busy || !text.trim()}>发送</Button>
        {busy && <Button size="sm" variant="outline" type="button" onClick={() => void act(() => call<Run>('stop', { task: taskId }))}>停止</Button>}
        {(run.status === 'failed' || run.status === 'stopped') && <Button size="sm" variant="outline" type="button" onClick={() => void act(() => call<Run>('start', { path, agent: run.agent }))}>重新开始</Button>}
      </form>
      {run.check && <details className={`agent-check ${run.check.ok ? 'green' : 'red'}`} open={!run.check.ok}><summary>检查{run.check.ok ? '通过' : run.check.timedOut ? '失败（超时）' : `失败（退出码 ${run.check.exit}）`} · {(run.check.ms / 1000).toFixed(1)}s · <code>{run.check.command}</code></summary><pre>{run.check.output || '（无输出）'}</pre></details>}
      {!busy && <div className="agent-review">
        {run.check !== undefined && run.isolated && !run.cleaned && <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('recheck', { task: taskId }))}>重新运行检查</Button>}
        {run.isolated && <Button size="sm" variant="outline" onClick={() => void call<Diff>(`diff?task=${encodeURIComponent(taskId)}`).then(next => { setDiff(next); setError(''); }, (cause: Error) => setError(cause.message))}>查看改动</Button>}
        {!run.accepted && <Button size="sm" onClick={() => { if (window.confirm(run.check && !run.check.ok ? '自动检查未通过。仍要将任务标记为完成？分支不会被自动合并。' : '确认已按验收条件检查，将任务标记为完成？分支不会被自动合并。')) void act(() => call<Run>('accept', { task: taskId })); }}>验收通过（设为完成）</Button>}
        {run.accepted && run.isolated && !run.cleaned && <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('cleanup', { task: taskId }))}>提交到分支并清理 worktree</Button>}
        {run.cleaned && run.branch ? <span className="muted">已清理。合并由你手动执行：<code>git merge {run.branch}</code></span> : <span className="muted">不满意：直接在上方输入意见并发送，Agent 会继续修改。</span>}
      </div>}
      {diff && <details open className="agent-diff"><summary>{diff.stat || '没有改动'}</summary><pre>{diff.patch}{diff.truncated ? '\n…（已截断）' : ''}</pre></details>}</>}
  </section>;
}

// Shows tasks whose dependencies are all done; starting is an explicit click, capped server-side.
export function ReadyBar({ onOpen }: { onOpen: (path: string) => void }) {
  const [ready, setReady] = useState<{ id: string; path: string; title: string }[]>([]);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let live = true;
    const poll = () => call<{ ready: typeof ready }>('ready').then(data => { if (live) setReady(data.ready); }, () => { if (live) setReady([]); });
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  if (!ready.length && !message) return null;
  return <div className="feedback ready-bar" role="status">
    {ready.length > 0 && <>可开始（依赖均已完成）：{ready.map(task => <button key={task.id} className="task-title" title={task.title} onClick={() => onOpen(task.path)}>{task.id}</button>)}
      <Button size="sm" onClick={() => void call<{ started: string[]; skipped: { id: string; reason: string }[] }>('start-ready', {}).then(
        result => setMessage(`已开始：${result.started.join('、') || '无'}${result.skipped.length ? `；跳过：${result.skipped.map(item => `${item.id}（${item.reason}）`).join('、')}` : ''}`), (cause: Error) => setMessage(cause.message))}>开始就绪任务</Button></>}
    {message && <span className="muted"> {message}</span>}
  </div>;
}
