import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';

type Item = { taskId: string; kind: 'task' | 'chat'; title: string; agent: string; status: string; updatedAt: string | null };
type Event = { seq: number; type: string; text: string; role?: string; model?: string };
type Usage = { cost_usd?: number; input: number; output: number; reasoning_output?: number; reasoning_coverage?: 'complete' | 'partial' | 'unknown'; cache_read: number; turns: number };
type Detail = { taskId: string; agent: string; status: string; yolo?: boolean; model?: string | null; reasoningEffort?: string | null; usage?: Usage | null; usageCoverage?: 'complete' | 'partial' | 'unknown'; persistenceError?: string | null; events: Event[]; pending?: { id: string; tool: string } };
const labels: Record<string, string> = { running: 'Running', blocked: 'Awaiting approval', idle: 'Idle', failed: 'Failed', stopped: 'Stopped' };
const names: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/agent/${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}
const store = {
  get: (key: string, fallback: string) => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } },
  set: (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } },
};
export function useChatOpen(): [boolean, (open: boolean) => void] {
  const [open, setOpen] = useState(() => store.get('olav-tasks-chat-open', '1') === '1');
  return [open, value => { setOpen(value); store.set('olav-tasks-chat-open', value ? '1' : '0'); }];
}
const Icon = ({ children }: { children: ReactNode }) => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>;
const icons = {
  chat: <Icon><path d="M21 12a8 8 0 0 1-11.6 7.1L3 21l1.9-5.4A8 8 0 1 1 21 12z"/></Icon>,
  plus: <Icon><path d="M12 5v14M5 12h14"/></Icon>,
  history: <Icon><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></Icon>,
  collapse: <Icon><path d="M9 6l6 6-6 6"/></Icon>,
};

// The toggle lives on the view-tab row so the chat can be opened or collapsed without leaving the tabs.
export function ChatToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <button type="button" className={`chat-toggle ${open ? 'on' : ''}`} onClick={onToggle} aria-pressed={open} aria-label={open ? 'Collapse chat' : 'Open chat'} title={open ? 'Collapse chat' : 'Open chat'}>{icons.chat}</button>;
}

// Right-hand panel: talks to the Claude Agent SDK or Codex SDK authenticated on the machine running the server. Agents work in the project root.
export function ChatDock({ onClose }: { onClose: () => void }) {
  const [agent, setAgent] = useState(() => store.get('olav-tasks-chat-agent', 'claude'));
  const [yolo, setYolo] = useState(() => store.get('olav-tasks-chat-yolo', '0') === '1');
  const [reasoningEffort, setReasoningEffort] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [yoloAllowed, setYoloAllowed] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [selected, setSelected] = useState('new');
  const [history, setHistory] = useState(false);
  const [detail, setDetail] = useState<Detail>();
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    const poll = () => call<{ enabled: boolean; yolo: boolean; runs: Item[] }>('runs').then(data => { if (live) { setEnabled(data.enabled); setYoloAllowed(data.yolo); setItems([...data.runs].sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))); } }, () => undefined);
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
  const shownAgent = selected === 'new' ? agent : current?.agent ?? detail?.agent;
  const busy = detail?.status === 'running' || detail?.status === 'blocked';
  const useYolo = yolo && yoloAllowed;
  async function submit() {
    const message = text.trim();
    if (!message) return;
    try {
      if (selected === 'new') setSelected((await call<Detail>('chat', { agent, text: message, yolo: useYolo, ...(agent === 'codex' && reasoningEffort ? { reasoningEffort } : {}) })).taskId);
      else await call<Detail>('send', { task: selected, text: message, yolo: useYolo });
      setText(''); setError('');
    } catch (cause) { setError((cause as Error).message); }
  }
  const act = (path: string, body: unknown) => call<Detail>(path, body).then(next => { setDetail(previous => (previous ? { ...next, events: previous.events } : next)); setError(''); }, (cause: Error) => setError(cause.message));
  function toggleYolo(on: boolean) {
    if (on && !window.confirm('YOLO mode bypasses every permission prompt and gives the agent full access to this machine (Codex also gets network access). Enable it?')) return;
    setYolo(on); store.set('olav-tasks-chat-yolo', on ? '1' : '0');
  }

  return <aside className="chat-dock" aria-label="Chat">
    <header className="chat-head">
      <span className="chat-agents" role="group" aria-label="Agent">{Object.keys(names).map(name => <button key={name} type="button" className={shownAgent === name ? 'on' : ''} disabled={selected !== 'new'} title={selected === 'new' ? `Use ${names[name]}` : 'An existing conversation keeps its agent; start a new one to switch'} onClick={() => { setAgent(name); store.set('olav-tasks-chat-agent', name); }}>{names[name]}</button>)}</span>
      <span className="chat-actions">
        <button type="button" className="icon-button" onClick={() => { setSelected('new'); setReasoningEffort(''); setHistory(false); setError(''); }} aria-label="New conversation" title="New conversation">{icons.plus}</button>
        <button type="button" className={`icon-button ${history ? 'on' : ''}`} onClick={() => setHistory(value => !value)} aria-label="History" aria-expanded={history} title="History">{icons.history}</button>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Collapse chat" title="Collapse chat">{icons.collapse}</button>
      </span>
    </header>
    {!enabled && <div className="feedback warning" role="status">Agents are only available on the machine running Olav Tasks.</div>}
    {history && <ul className="chat-history">{items.length ? items.map(item => <li key={item.taskId}><button className={item.taskId === selected ? 'on' : ''} onClick={() => { setSelected(item.taskId); setHistory(false); }}><span>{item.title}</span><small>{names[item.agent] ?? item.agent} · {labels[item.status] ?? item.status}{item.kind === 'task' ? ' · task' : ''}</small></button></li>) : <li className="muted">No conversations yet</li>}</ul>}
    {error && <div className="feedback error" role="alert">{error}</div>}
    <div className="chat-body">
      {selected === 'new' && <p className="muted">Type a message to start. The agent works in the project root.</p>}
      {detail && <>
        <div className="chat-meta">
          <span className={`status-badge ${detail.status}`}>{names[detail.agent] ?? detail.agent} · {labels[detail.status] ?? detail.status}</span>
          {detail.yolo && <span className="yolo-badge" title="This turn ran with all permission checks bypassed">YOLO</span>}
          {detail.model && <small className="muted">Requested model: {detail.model}</small>}
          {detail.reasoningEffort && <small className="muted">Requested reasoning: {detail.reasoningEffort}</small>}
          <small className="muted" title="Reasoning output is included in output tokens; cost is the SDK's local estimate, not a bill">Usage {detail.usageCoverage ?? 'unknown'} · {detail.usage ? `${detail.usage.cost_usd !== undefined ? `≈ $${detail.usage.cost_usd.toFixed(2)}` : 'cost unknown'} · in ${k(detail.usage.input)} · out ${k(detail.usage.output)} · reasoning output ${detail.usage.reasoning_output === undefined ? 'unknown' : `${k(detail.usage.reasoning_output)} (${detail.usage.reasoning_coverage ?? 'unknown'})`} · ${detail.usage.turns} counted turns` : 'no reported turns · reasoning output unknown'}</small>
        </div>
        {detail.persistenceError && <div className="feedback error" role="alert">{detail.persistenceError}</div>}
        <ol className="chat-log">{detail.events.map(event => <li key={event.seq} className={`agent-${event.type}`}><strong>{event.role ? `${event.role}${event.model ? ` · ${event.model}` : ''}` : event.type === 'user' ? 'You' : event.type}</strong> {event.text}</li>)}<div ref={bottom}/></ol>
        {detail.pending && <div className="feedback warning" role="status">Approval needed: {detail.pending.tool}
          <Button size="sm" onClick={() => void act('permission', { task: selected, id: detail.pending!.id, allow: true })}>Allow</Button>
          <Button size="sm" variant="outline" onClick={() => void act('permission', { task: selected, id: detail.pending!.id, allow: false })}>Deny</Button></div>}
      </>}
    </div>
    <form className="chat-input" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <textarea value={text} rows={3} disabled={!enabled || busy} placeholder={selected === 'new' ? 'Message (Enter to send, Shift+Enter for a new line)' : 'Continue…'} aria-label="Message"
        onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }}/>
      <div className="chat-send">
        {selected === 'new' && agent === 'codex' && <label className="muted">Reasoning <select aria-label="Codex reasoning effort" value={reasoningEffort} onChange={event => setReasoningEffort(event.target.value)}><option value="">Default (server setting)</option>{['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent'].map(value => <option key={value} value={value}>{value}</option>)}</select></label>}
        <label className={`yolo-option ${useYolo ? 'on' : ''}`} title={yoloAllowed ? 'Bypass all permission prompts for the next message' : 'YOLO is only available on the machine running Olav Tasks'}>
          <input type="checkbox" checked={useYolo} disabled={!enabled || !yoloAllowed} onChange={event => toggleYolo(event.target.checked)}/> YOLO
        </label>
        <span>{busy && <Button size="sm" variant="outline" type="button" onClick={() => void act('stop', { task: selected })}>Stop</Button>}<Button size="sm" type="submit" disabled={!enabled || busy || !text.trim()}>Send</Button></span>
      </div>
    </form>
  </aside>;
}
