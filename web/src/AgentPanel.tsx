import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type AgentEvent = { seq: number; type: string; text: string };
type Run = { status: 'running' | 'blocked' | 'idle' | 'failed' | 'stopped'; agent: string; events: AgentEvent[]; pending?: { id: string; tool: string } };
const labels: Record<string, string> = { running: '运行中', blocked: '等待批准', idle: '等待下一条指令', failed: '失败', stopped: '已停止' };
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data as T;
}
export function AgentPanel({ taskId, path }: { taskId: string; path: string }) {
  const [run, setRun] = useState<Run>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const act = (action: () => Promise<Run>) => action().then(next => { setRun(next); setError(''); }, (cause: Error) => setError(cause.message));
  useEffect(() => {
    let live = true; let seen = 0; let events: AgentEvent[] = [];
    setRun(undefined);
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
    <h4>开发 Agent{run && <span className={`status-badge ${run.status}`}> {run.agent} · {labels[run.status]}</span>}</h4>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {!run && <Button size="sm" onClick={() => void act(() => call<Run>('start', { path }))}>用 Claude 开始</Button>}
    {run && <>
      <ol className="agent-log">{run.events.map(event => <li key={event.seq} className={`agent-${event.type}`}><strong>{event.type}</strong> {event.text}</li>)}</ol>
      {run.pending && <div className="feedback warning" role="status">需要批准：{run.pending.tool}
        <Button size="sm" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: true }))}>允许</Button>
        <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: false }))}>拒绝</Button></div>}
      <form className="agent-input" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; void act(() => call<Run>('send', { task: taskId, text })).then(() => setText('')); }}>
        <input value={text} onChange={event => setText(event.target.value)} disabled={busy} placeholder="给 Agent 的下一条指令" aria-label="给 Agent 的指令"/>
        <Button size="sm" type="submit" disabled={busy || !text.trim()}>发送</Button>
        {busy && <Button size="sm" variant="outline" type="button" onClick={() => void act(() => call<Run>('stop', { task: taskId }))}>停止</Button>}
        {(run.status === 'failed' || run.status === 'stopped') && <Button size="sm" variant="outline" type="button" onClick={() => void act(() => call<Run>('start', { path }))}>重新开始</Button>}
      </form></>}
  </section>;
}
