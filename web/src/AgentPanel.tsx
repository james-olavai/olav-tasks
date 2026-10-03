import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';

type AgentEvent = { seq: number; type: string; text: string; role?: string; model?: string };
type Diff = { branch: string; stat: string; patch: string; truncated: boolean };
type Usage = { cost_usd?: number; input: number; output: number; cache_read: number; cache_write: number; turns: number };
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
// Cost is a client-side estimate and absent when the agent does not report it.
const usageText = (u: Usage) => `${u.cost_usd !== undefined ? `≈ $${u.cost_usd.toFixed(2)} · ` : 'cost unknown · '}in ${k(u.input)} · out ${k(u.output)} · cache read ${k(u.cache_read)} · ${u.turns} turns`;
type Check = { command: string; ok: boolean; exit: number | null; timedOut: boolean; ms: number; output: string };
type Run = { check?: Check | null; cleaned?: boolean; usage?: Usage | null; model?: string | null; branch?: string; isolated?: boolean; accepted?: boolean; status: 'running' | 'blocked' | 'idle' | 'failed' | 'stopped'; agent: string; events: AgentEvent[]; pending?: { id: string; tool: string } };
const labels: Record<string, string> = { running: 'Running', blocked: 'Awaiting approval', idle: 'Waiting for input', failed: 'Failed', stopped: 'Stopped' };
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}
// Review panel for a task run that already exists (runs can no longer be started from here; conversations start in the chat dock).
export function AgentPanel({ taskId }: { taskId: string }) {
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
  if (!run) return null;
  return <section className="agent-panel" aria-label="Agent">
    <h4>Agent{run && <span className={`status-badge ${run.status}`}> {run.agent} · {labels[run.status]}{run.accepted ? ' · accepted' : ''}</span>}{run?.usage && <span className="agent-branch" title="Cost is the SDK's local estimate, not a bill"> {usageText(run.usage)}</span>}{run?.branch && <code className="agent-branch"> {run.branch}{run.model ? ` · ${run.model}` : ''}</code>}</h4>
    {error && <div className="feedback error" role="alert">{error}</div>}
    {run && <>
      <ol className="agent-log">{run.events.map(event => <li key={event.seq} className={`agent-${event.type}`}><strong>{event.role ? `${event.role}${event.model ? ` · ${event.model}` : ''}` : event.type}</strong> {event.text}</li>)}</ol>
      {run.pending && <div className="feedback warning" role="status">Approval needed: {run.pending.tool}
        <Button size="sm" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: true }))}>Allow</Button>
        <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('permission', { task: taskId, id: run.pending!.id, allow: false }))}>Deny</Button></div>}
      <form className="agent-input" onSubmit={event => { event.preventDefault(); if (!text.trim()) return; void act(() => call<Run>('send', { task: taskId, text })).then(() => setText('')); }}>
        <input value={text} onChange={event => setText(event.target.value)} disabled={busy} placeholder="Next instruction for the agent" aria-label="Instruction for the agent"/>
        <Button size="sm" type="submit" disabled={busy || !text.trim()}>Send</Button>
        {busy && <Button size="sm" variant="outline" type="button" onClick={() => void act(() => call<Run>('stop', { task: taskId }))}>Stop</Button>}
      </form>
      {run.check && <details className={`agent-check ${run.check.ok ? 'green' : 'red'}`} open={!run.check.ok}><summary>Check {run.check.ok ? 'passed' : run.check.timedOut ? 'failed (timed out)' : `failed (exit ${run.check.exit})`} · {(run.check.ms / 1000).toFixed(1)}s · <code>{run.check.command}</code></summary><pre>{run.check.output || '(no output)'}</pre></details>}
      {!busy && <div className="agent-review">
        {run.check !== undefined && run.isolated && !run.cleaned && <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('recheck', { task: taskId }))}>Re-run check</Button>}
        {run.isolated && <Button size="sm" variant="outline" onClick={() => void call<Diff>(`diff?task=${encodeURIComponent(taskId)}`).then(next => { setDiff(next); setError(''); }, (cause: Error) => setError(cause.message))}>View changes</Button>}
        {!run.accepted && <Button size="sm" onClick={() => { if (window.confirm(run.check && !run.check.ok ? 'The automatic check did not pass. Mark the task done anyway? The branch is not merged automatically.' : 'Confirm you checked the acceptance criteria and mark the task done? The branch is not merged automatically.')) void act(() => call<Run>('accept', { task: taskId })); }}>Accept (mark done)</Button>}
        {run.accepted && run.isolated && !run.cleaned && <Button size="sm" variant="outline" onClick={() => void act(() => call<Run>('cleanup', { task: taskId }))}>Commit to branch and clean up worktree</Button>}
        {run.cleaned && run.branch ? <span className="muted">Cleaned up. Merge manually: <code>git merge {run.branch}</code></span> : <span className="muted">Not satisfied? Type feedback above and send; the agent will keep working.</span>}
      </div>}
      {diff && <details open className="agent-diff"><summary>{diff.stat || 'No changes'}</summary><pre>{diff.patch}{diff.truncated ? '\n… (truncated)' : ''}</pre></details>}</>}
  </section>;
}
