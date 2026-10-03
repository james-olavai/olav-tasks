import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';

type Task = { id: string; title: string; path: string; status: string };
type Item = { taskId: string; kind: 'task' | 'chat'; title: string; agent: string; status: string; updatedAt: string | null; path?: string };
type Event = { seq: number; type: string; text: string; role?: string; model?: string };
type Usage = { cost_usd?: number; input: number; output: number; cache_read: number; turns: number };
type Check = { ok: boolean; exit: number | null; timedOut: boolean };
type Detail = { taskId: string; agent: string; status: string; kind: string; usage?: Usage | null; check?: Check | null; events: Event[]; pending?: { id: string; tool: string } };
const labels: Record<string, string> = { running: '运行中', blocked: '等待批准', idle: '空闲', failed: '失败', stopped: '已停止' };
const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `请求失败 (${response.status})`);
  return data as T;
}
const store = {
  get: (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};

// Top-level right-hand chat: collapsible, new conversation, history, Claude/Codex switch. It talks to the SDKs authenticated on the server machine.
export function ChatDock({ tasks, onOpenTask }: { tasks: Task[]; onOpenTask: (path: string) => void }) {
  const [open, setOpen] = useState(() => store.get('olav-tasks-chat-open', '1') === '1');
  const [agent, setAgent] = useState(() => store.get('olav-tasks-chat-agent', 'claude'));
  const [enabled, setEnabled] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState<string>('new');
  const [history, setHistory] = useState(false);
  const [detail, setDetail] = useState<Detail>();
  const [taskId, setTaskId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => { document.body.classList.toggle('chat-open', open); store.set('olav-tasks-chat-open', open ? '1' : '0'); return () => document.body.classList.remove('chat-open'); }, [open]);
  useEffect(() => {
    let live = true;
    const poll = () => call<{ enabled: boolean; runs: Item[] }>('runs').then(data => { if (live) { setEnabled(data.enabled); setItems([...data.runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))); } }, () => undefined);
    void poll(); const timer = setInterval(() => void poll(), 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    setDetail(undefined);
    if (selected === 'new') return;
    let live = true; let seen = 0; let events: Event[] = [];
    const poll = async () => {
      try {
        const next = await call<Detail>(`run?task=${encodeURIComponent(selected)}&since=${seen}`);
        events = [...events, ...next.events]; seen = events.at(-1)?.seq ?? seen;
        if (live) setDetail({ ...next, events });
      } catch { /* run not available */ }
    };
    void poll(); const timer = setInterval(() => void poll(), 1000);
    return () => { live = false; clearInterval(timer); };
  }, [selected]);
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [detail?.events.length]);

  const current = items.find(item => item.taskId === selected);
  const busy = detail?.status === 'running' || detail?.status === 'blocked';
  const usedTasks = new Set(items.filter(item => item.kind === 'task').map(item => item.taskId));
  const available = tasks.filter(task => task.status !== 'done' && !usedTasks.has(task.id));
  async function submit() {
    const message = text.trim();
    if (!message) return;
    try {
      if (selected === 'new') {
        const task = tasks.find(item => item.id === taskId);
        const started = task ? await call<Detail>('start', { path: task.path, agent, message }) : await call<Detail>('chat', { agent, text: message });
        setSelected(started.taskId);
      } else await call<Detail>('send', { task: selected, text: message });
      setText(''); setError('');
    } catch (cause) { setError((cause as Error).message); }
  }
  const act = (path: string, body: unknown) => call<Detail>(path, body).then(next => { setDetail(previous => (previous ? { ...next, events: previous.events } : next)); setError(''); }, (cause: Error) => setError(cause.message));

  if (!open) return <button className="chat-tab" onClick={() => setOpen(true)} aria-label="打开对话">对话</button>;
  return <aside className="chat-dock" aria-label="对话">
    <header className="chat-head">
      <strong>对话</strong>
      <span className="chat-agents" role="group" aria-label="选择 Agent">{Object.keys(names).map(name => <button key={name} className={(selected === 'new' ? agent : current?.agent ?? detail?.agent) === name ? 'on' : ''} disabled={selected !== 'new'} title={selected === 'new' ? `用 ${names[name]} 开始新会话` : '已有会话不能切换 Agent，请新建会话'} onClick={() => { setAgent(name); store.set('olav-tasks-chat-agent', name); }}>{names[name]}</button>)}</span>
      <span className="chat-actions">
        <Button size="sm" variant="outline" onClick={() => { setSelected('new'); setHistory(false); setError(''); }}>新建</Button>
        <Button size="sm" variant="outline" onClick={() => setHistory(value => !value)} aria-expanded={history}>历史 {items.length}</Button>
        <Button size="sm" variant="outline" onClick={() => setOpen(false)} aria-label="折叠对话">折叠</Button>
      </span>
    </header>
    {!enabled && <div className="feedback warning" role="status">Agent 只能在运行服务的这台机器上使用；局域网访问时这里只读。</div>}
    {history && <ul className="chat-history">{items.length ? items.map(item => <li key={item.taskId}><button className={item.taskId === selected ? 'on' : ''} onClick={() => { setSelected(item.taskId); setHistory(false); }}><span>{item.title}</span><small>{names[item.agent] ?? item.agent} · {labels[item.status] ?? item.status}{item.kind === 'task' ? ' · 任务' : ''}</small></button></li>) : <li className="muted">还没有会话</li>}</ul>}
    {error && <div className="feedback error" role="alert">{error}</div>}
    <div className="chat-body">
      {selected === 'new' && <div className="chat-new">
        <p className="muted">直接输入开始。不关联任务时是只读对话；关联任务则在该任务的独立 worktree 里工作。</p>
        <label>关联任务（可选） <select value={taskId} onChange={event => setTaskId(event.target.value)}><option value="">不关联（只读对话）</option>{available.map(task => <option key={task.id} value={task.id}>{task.id} {task.title}</option>)}</select></label>
      </div>}
      {detail && <>
        <div className="chat-meta">{current?.kind === 'task' && current.path && <button className="task-title" onClick={() => onOpenTask(current.path!)}>在任务页审阅 / 验收</button>}
          <span className={`status-badge ${detail.status}`}>{names[detail.agent] ?? detail.agent} · {labels[detail.status] ?? detail.status}</span>
          {detail.usage && <small className="muted" title="费用为 SDK 本地估算，非账单">{detail.usage.cost_usd !== undefined ? `约 $${detail.usage.cost_usd.toFixed(2)} · ` : ''}输入 {k(detail.usage.input)} · 输出 {k(detail.usage.output)}</small>}
          {detail.check && <small className={detail.check.ok ? '' : 'agent-error'}>检查{detail.check.ok ? '通过' : '失败'}</small>}</div>
        <ol className="chat-log">{detail.events.map(event => <li key={event.seq} className={`agent-${event.type}`}><strong>{event.role ? `${event.role}${event.model ? ` · ${event.model}` : ''}` : event.type === 'user' ? '你' : event.type}</strong> {event.text}</li>)}<div ref={bottom}/></ol>
        {detail.pending && <div className="feedback warning" role="status">需要批准：{detail.pending.tool}
          <Button size="sm" onClick={() => void act('permission', { task: selected, id: detail.pending!.id, allow: true })}>允许</Button>
          <Button size="sm" variant="outline" onClick={() => void act('permission', { task: selected, id: detail.pending!.id, allow: false })}>拒绝</Button></div>}
      </>}
    </div>
    <form className="chat-input" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea value={text} rows={3} disabled={!enabled || busy} placeholder={selected === 'new' ? '输入你想做的事，回车发送（Shift+回车换行）' : '继续对话…'} aria-label="消息"
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
      <span>{busy && <Button size="sm" variant="outline" type="button" onClick={() => void act('stop', { task: selected })}>停止</Button>}<Button size="sm" type="submit" disabled={!enabled || busy || !text.trim()}>发送</Button></span>
    </form>
  </aside>;
}
