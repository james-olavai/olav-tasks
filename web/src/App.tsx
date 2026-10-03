import { Children, createElement, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { AgentPanel } from './AgentPanel';
import { ChatDock, ChatToggle, useChatOpen } from './ChatDock';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

type Status = 'todo' | 'in-progress' | 'done';
type Task = { path: string; id: string; title: string; status: Status; priority?: string; assignee?: string; effort?: 'S' | 'M' | 'L'; model_profile?: 'fast' | 'balanced' | 'deep'; check?: string; start_date?: string; end_date?: string; depends_on: string[]; version: string };
type Entry = { path: string; type: 'file' | 'directory' };
type File = { path: string; content: string; version: string; isTask?: boolean };
type Board = { tasks: Task[]; diagnostics: { path: string; message: string }[]; revision: string };
const columns: { status: Status; label: string }[] = [{ status: 'todo', label: 'To do' }, { status: 'in-progress', label: 'In progress' }, { status: 'done', label: 'Done' }];
async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(`/api/${path}`, body === undefined ? undefined : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}
function resolveLocal(current: string, target: string): string | undefined {
  if (!target || target.startsWith('/') || target.startsWith('//') || /^[a-z][a-z\d+.-]*:/i.test(target)) return;
  try {
    const parts = current.split('/').slice(0, -1);
    for (const part of decodeURIComponent(target.split(/[?#]/)[0]).split('/')) {
      if (part === '..') { if (!parts.length) return; parts.pop(); }
      else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  } catch { return; }
}
function headingText(children: ReactNode): string {
  return Children.toArray(children).map(child => typeof child === 'string' || typeof child === 'number' ? String(child) : isValidElement<{ children?: ReactNode }>(child) ? headingText(child.props.children) : '').join('');
}
function heading(level: number, children: ReactNode) {
  const id = headingText(children).trim().toLowerCase().replace(/[^\p{L}\p{M}\p{N}_\-\s]/gu, '').replace(/\s/g, '-');
  return createElement(`h${level}`, { id: id || undefined }, children);
}
function bodyOnly(content: string) { return content.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, ''); }
export function App() {
  const [project, setProject] = useState<{ name: string; root: string; version: string }>();
  const [board, setBoard] = useState<Board>();
  const [tree, setTree] = useState<{ entries: Entry[]; truncated: boolean }>();
  const [tab, setTab] = useState('board');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [file, setFile] = useState<File>();
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState(false);
  const [external, setExternal] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [syncError, setSyncError] = useState('');
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState(false);
  const [create, setCreate] = useState<'file' | 'directory'>();
  const [newPath, setNewPath] = useState('');
  const [movePath, setMovePath] = useState<string>();
  const [lastSync, setLastSync] = useState('');
  const [chatOpen, setChatOpen] = useChatOpen();
  const current = useRef({ file, draft }); current.current = { file, draft };
  const busyRef = useRef(false);
  const revision = useRef('');
  const openingId = useRef(0);
  const refreshId = useRef(0);
  const taskFile = !!file && (file.isTask === true || !!board?.tasks.some(task => task.path === file.path));
  const dirty = !!file && draft !== file.content;
  const tasks = [...(board?.tasks ?? [])].sort((a, b) => (a.priority ?? 'P3').localeCompare(b.priority ?? 'P3') || a.id.localeCompare(b.id, 'en', { numeric: true }) || a.path.localeCompare(b.path));
  const refresh = useCallback(async () => {
    const id = ++refreshId.current;
    const [nextProject, nextBoard, nextTree] = await Promise.all([
      api<{ name: string; root: string; version: string }>('project'), api<Board>('tasks'), api<{ entries: Entry[]; truncated: boolean }>('tree'),
    ]);
    if (id !== refreshId.current) return;
    setProject(nextProject); setBoard(nextBoard); setTree(nextTree);
    revision.current = nextBoard.revision; setLastSync(new Date().toLocaleTimeString());
  }, []);
  const retry = useCallback(async () => {
    setLoading(true); setSyncError('');
    try { await refresh(); } catch (e) { setSyncError(String((e as Error).message)); } finally { setLoading(false); }
  }, [refresh]);
  useEffect(() => { void retry(); }, [retry]);
  useEffect(() => {
    let active = true; let checking = false;
    const timer = window.setInterval(async () => {
      if (checking || busyRef.current) return;
      checking = true;
      try {
        const next = await api<{ revision: string }>('revision');
        if (!active || busyRef.current) return;
        if (next.revision !== revision.current) {
          await refresh();
          const previous = current.current;
          if (previous.file) {
            try {
              const updated = await api<File>(`file?path=${encodeURIComponent(previous.file.path)}`);
              if (!active || current.current.file?.path !== previous.file.path || current.current.file.version !== previous.file.version || busyRef.current) return;
              if (updated.version !== previous.file.version) {
                if (current.current.draft !== previous.file.content) setExternal('The file was changed externally. Your unsaved edits are kept; saving checks the version, so copy your content or reload first.');
                else { setFile(updated); setDraft(updated.content); setExternal(''); }
              }
            } catch (e) { if (active && current.current.file?.path === previous.file.path) setExternal(`The current file may have been deleted or moved: ${(e as Error).message}. Your content is kept.`); }
          }
        }
        if (active) { setSyncError(''); setLastSync(new Date().toLocaleTimeString()); }
      } catch (e) { if (active) setSyncError(`Auto-sync failed: ${(e as Error).message}`); }
      finally { checking = false; }
    }, 2000);
    return () => { active = false; clearInterval(timer); };
  }, [refresh]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (current.current.file && current.current.draft !== current.current.file.content) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, []);
  async function open(path: string, force = false) {
    if (busyRef.current) return;
    if (dirty && !window.confirm(force ? 'Reloading discards unsaved edits. Continue?' : 'Switching files discards unsaved edits. Continue?')) return;
    const id = ++openingId.current; setError(''); setNotice(''); setOpening(true); setTab('files');
    try {
      const next = await api<File>(`file?path=${encodeURIComponent(path)}`);
      if (id !== openingId.current) return;
      setFile(next); setDraft(next.content); setEditing(false); setExternal(''); setMovePath(undefined);
      const parents = path.split('/'); parents.pop();
      setExpanded(previous => new Set([...previous, ...parents.map((_, index) => parents.slice(0, index + 1).join('/'))]));
    } catch (e) { if (id === openingId.current) setError((e as Error).message); }
    finally { if (id === openingId.current) setOpening(false); }
  }
  async function mutate(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; ++refreshId.current; setBusy(true); setError(''); setNotice('');
    try { await action(); try { await refresh(); setSyncError(''); } catch (e) { setSyncError(`The operation completed, but refreshing failed: ${(e as Error).message}`); } }
    catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  function renderEntries(parent = '') {
    return tree?.entries.filter(entry => entry.path.split('/').slice(0, -1).join('/') === parent).map(entry => {
      const directory = entry.type === 'directory'; const isExpanded = expanded.has(entry.path);
      return <li key={entry.path}><button className={`tree-entry ${file?.path === entry.path ? 'selected' : ''}`} aria-expanded={directory ? isExpanded : undefined} aria-current={file?.path === entry.path ? 'page' : undefined} title={entry.path} disabled={busy || opening}
        onClick={() => directory ? setExpanded(previous => { const next = new Set(previous); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; }) : /\.md$/i.test(entry.path) ? void open(entry.path) : setNotice('Markdown files can be previewed and edited; other files only appear in the directory.')}>
        <span aria-hidden="true">{directory ? isExpanded ? '▾' : '▸' : '·'}</span><span>{entry.path.split('/').pop()}</span></button>{directory && isExpanded && <ul>{renderEntries(entry.path)}</ul>}</li>;
    });
  }
  const markdown = file ? <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml components={{
    h1: ({ children }) => heading(1, children), h2: ({ children }) => heading(2, children), h3: ({ children }) => heading(3, children),
    h4: ({ children }) => heading(4, children), h5: ({ children }) => heading(5, children), h6: ({ children }) => heading(6, children),
    a: ({ href, children }) => {
      if (href?.startsWith('#')) return <a href={href}>{children}</a>;
      const target = href && resolveLocal(file.path, href);
      if (target) return <a href={href} onClick={event => { event.preventDefault(); if (/\.md$/i.test(target)) void open(target); else setNotice('This link is not a Markdown file and cannot be opened here.'); }}>{children}</a>;
      return href && /^(https?:|mailto:)/i.test(href) ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a> : <span>{children}</span>;
    },
    img: ({ src, alt }) => { const path = typeof src === 'string' ? resolveLocal(file.path, src) : undefined; return path ? <img src={`/api/asset?path=${encodeURIComponent(path)}`} alt={alt ?? ''} loading="lazy" /> : <span className="muted">[Image not loaded: only project-relative image paths are supported] {alt}</span>; },
  }}>{bodyOnly(draft)}</ReactMarkdown> : null;
  return <div className="workspace">
    <header className="app-header"><span className="brand"><span className="brand-mark" aria-hidden="true">O</span>Olav Tasks</span><span className="project-name" title={project?.root}>{project?.name ?? 'Project'}</span><span className="sync-label" title={`Last sync ${lastSync || '—'}`}>{syncError ? 'Connection problem' : 'Local'}</span></header>
    <div className="workspace-body"><div className="main-scroll"><main className="main-content">
      {syncError && <div className="feedback error" role="alert">{syncError}<Button variant="outline" size="sm" onClick={() => void retry()} disabled={loading}>Reconnect</Button></div>}
      {error && <div className="feedback error" role="alert">{error}<button onClick={() => setError('')} aria-label="Dismiss error">×</button></div>}
      <div aria-live="polite">{notice && <div className="feedback">{notice}</div>}</div>
      {loading && <p role="status">Loading project…</p>}
      <Tabs value={tab} onValueChange={value => { if (dirty && value !== tab && !window.confirm('Keep unsaved edits and switch view?')) return; setTab(value); }} className="view-tabs"><div className="tab-row"><TabsList aria-label="Project views">{views.map(view => <TabsTrigger key={view.value} value={view.value} title={view.label} aria-label={view.label}><ViewIcon kind={view.value}/></TabsTrigger>)}</TabsList><ChatToggle open={chatOpen} onToggle={() => setChatOpen(!chatOpen)}/></div>
        <TabsContent value="backlog">{!tasks.length ? <p className="empty-label">No tasks</p> : <div className="table-scroll"><table className="backlog-table"><thead><tr><th>Task</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Effort</th><th>Model tier</th><th>Depends on</th><th>Dates</th></tr></thead><tbody>{tasks.map(task => <tr key={task.path}><td><button className="backlog-task" disabled={busy || opening} onClick={() => void open(task.path)}><span className="task-id">{task.id}</span>{task.title}</button></td><td><span className={`status-badge ${task.status}`}>{columns.find(column => column.status === task.status)?.label}</span></td><td>{task.priority ?? '—'}</td><td className="assignee-cell">{task.assignee ?? 'Unassigned'}</td><td>{task.effort ?? '—'}</td><td>{task.model_profile ?? '—'}</td><td className="dependencies-cell">{task.depends_on.join(', ') || '—'}</td><td className="date-cell">{task.start_date ?? '—'} / {task.end_date ?? '—'}</td></tr>)}</tbody></table></div>}</TabsContent>
        <TabsContent value="board">
          {!tasks.length && <p className="empty-label">No tasks</p>}
          <div className="kanban">{columns.map(column => <section className="kanban-column" key={column.status} aria-label={column.label}><h3>{column.label}<span>{tasks.filter(task => task.status === column.status).length}</span></h3>
            {tasks.filter(task => task.status === column.status).map(task => <Card className="task-card" key={task.path}><div className="task-meta"><span>{task.id}</span>{task.priority && <span className="priority">{task.priority}</span>}</div><button className="task-title" disabled={busy || opening} onClick={() => void open(task.path)}>{task.title}</button><dl className="task-collaboration"><div><dt>Assignee</dt><dd>{task.assignee ?? 'Unassigned'}</dd></div><div><dt>Effort</dt><dd>{task.effort ?? '—'}</dd></div><div><dt>Model tier</dt><dd>{task.model_profile ?? '—'}</dd></div></dl>{task.depends_on.length > 0 && <p className="task-dependencies">Depends on: {task.depends_on.join(', ')}</p>}<p className="task-path">{task.path}</p></Card>)}
          </section>)}</div>
        </TabsContent>
        <TabsContent value="dependencies"><DependencyGraph tasks={tasks} onOpen={path => void open(path)} disabled={busy || opening}/></TabsContent>
        <TabsContent value="gantt"><Gantt tasks={tasks} onOpen={path => void open(path)} disabled={busy || opening}/></TabsContent>
        <TabsContent value="files"><div className="file-actions"><div className="toolbar"><Button variant="outline" disabled={busy} onClick={() => { setCreate('file'); setNewPath(''); }}>New Markdown</Button><Button variant="outline" disabled={busy} onClick={() => { setCreate('directory'); setNewPath(''); }}>New folder</Button></div></div>
          {create && <form className="operation-form" onSubmit={event => { event.preventDefault(); if (dirty && create === 'file' && !window.confirm('Creating and opening a file discards the current unsaved edits. Continue?')) return; void mutate(async () => { if (create === 'directory') await api('directory', { path: newPath }); else { const next = await api<File>('file', { path: newPath, content: '# New document\n', version: null }); setFile(next); setDraft(next.content); setEditing(true); setExternal(''); } setCreate(undefined); setNotice('Created'); }); }}><label>{create === 'file' ? 'New Markdown path (ends with .md)' : 'New folder path (the parent directory must exist)'}<input value={newPath} onChange={event => setNewPath(event.target.value)} placeholder={create === 'file' ? 'docs/plan.md' : 'docs/new-folder'} required disabled={busy}/></label><Button type="submit" disabled={busy}>Create</Button><Button type="button" variant="ghost" onClick={() => setCreate(undefined)} disabled={busy}>Cancel</Button></form>}
          <div className="file-workspace"><aside className="file-sidebar" aria-label="Project directory">{tree?.truncated && <p className="feedback">Too many entries; the list is truncated.</p>}<ul className="file-tree">{renderEntries()}</ul>{tree && !tree.entries.length && <p className="muted">Empty directory</p>}</aside>
            <section className="document-panel" aria-label="Document">{opening && <p role="status">Loading file…</p>}{file ? <><div className="document-heading"><h3>{file.path}{taskFile && <span className="readonly-badge">Read-only task</span>}</h3><div className="toolbar">{!taskFile && <><Button variant="outline" size="sm" disabled={busy || opening} onClick={() => setEditing(value => !value)}>{editing ? 'Preview' : 'Edit'}</Button><Button size="sm" disabled={busy || opening || !dirty} onClick={() => void mutate(async () => { const next = await api<File>('file', { path: file.path, content: draft, version: file.version }); setFile(next); setDraft(next.content); setExternal(''); setNotice('Saved'); })}>Save{dirty ? ' *' : ''}</Button></>}<Button variant="outline" size="sm" disabled={busy || opening} onClick={() => void open(file.path, true)}>Reload</Button><Button variant="outline" size="sm" disabled={busy || opening} onClick={() => setMovePath(file.path)}>Move / rename</Button><Button variant="destructive" size="sm" disabled={busy || opening} onClick={() => { if (window.confirm(`Delete ${file.path}? ${dirty ? 'Unsaved edits are discarded too. ' : ''}This cannot be undone here.`)) void mutate(async () => { await api('file', { path: file.path, version: file.version }, 'DELETE'); setFile(undefined); setDraft(''); setExternal(''); setMovePath(undefined); setNotice('File deleted'); }); }}>Delete</Button></div></div>
              {external && <div className="feedback warning" role="status">{external}</div>}
              {movePath !== undefined && <form className="operation-form" onSubmit={event => { event.preventDefault(); if (dirty && !window.confirm('Moving discards unsaved edits. Continue?')) return; if (!window.confirm('Moving or renaming may break existing relative links; the tool does not repair references. Continue?')) return; void mutate(async () => { const next = await api<File & { warning: string }>('move', { path: file.path, to: movePath, version: file.version }); setFile(next); setDraft(next.content); setExternal(''); setMovePath(undefined); setNotice(next.warning || 'Moved; existing references were not repaired.'); }); }}><label>Target file path<input value={movePath} onChange={event => setMovePath(event.target.value)} required disabled={busy}/></label><p className="muted">The target parent directory must exist; existing files are not overwritten and document links are not changed.</p><Button type="submit" disabled={busy}>Confirm move</Button><Button type="button" variant="ghost" onClick={() => setMovePath(undefined)}>Cancel</Button></form>}
              {editing && !taskFile ? <><label className="editor-label" htmlFor="markdown-editor">Markdown source (including frontmatter){dirty ? ' · unsaved' : ''}</label><textarea id="markdown-editor" className="markdown-editor" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} disabled={busy || opening}/></> : <article className="markdown-body">{markdown}</article>}
              {taskFile && (() => { const task = board?.tasks.find(item => item.path === file.path); return task ? <AgentPanel taskId={task.id} path={task.path} version={task.version} profile={task.model_profile}/> : null; })()}
            </> : <div className="document-empty"><h3>Select a Markdown file</h3></div>}</section></div>
        </TabsContent>
      </Tabs>
      {!!board?.diagnostics.length && <details className="diagnostics"><summary>Task diagnostics ({board.diagnostics.length})</summary><ul>{board.diagnostics.map((item, index) => <li key={`${item.path}-${index}`}><button onClick={() => void open(item.path)}>{item.path}</button>: {item.message}</li>)}</ul></details>}
    </main></div>
    {chatOpen && <ChatDock onClose={() => setChatOpen(false)}/>}
    </div>
  </div>;
}

const views = [{ value: 'backlog', label: 'Backlog' }, { value: 'board', label: 'Kanban' }, { value: 'dependencies', label: 'Dependencies' }, { value: 'gantt', label: 'Gantt' }, { value: 'files', label: 'Files' }];
function ViewIcon({ kind }: { kind: string }) {
  const paths: Record<string, ReactNode> = {
    backlog: <><path d="M8 6h12M8 12h12M8 18h12"/><path d="M3 6h1M3 12h1M3 18h1"/></>,
    board: <><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="14" rx="1"/></>,
    dependencies: <><rect x="2" y="9" width="6" height="6" rx="1"/><rect x="16" y="2" width="6" height="6" rx="1"/><rect x="16" y="16" width="6" height="6" rx="1"/><path d="M8 12h4V5h4M12 12v7h4"/></>,
    gantt: <><path d="M4 3v18h17M8 6h6M11 11h9M7 16h9"/></>,
    files: <><path d="M3 7V4h7l2 3h9v13H3z"/></>,
  };
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[kind]}</svg>;
}
type TaskViewProps = { tasks: Task[]; onOpen: (path: string) => void; disabled: boolean };
function DependencyGraph({ tasks, onOpen, disabled }: TaskViewProps) {
  if (!tasks.length) return <p className="empty-label">No tasks</p>;
  const neighbors = new Map<string, Set<string>>();
  for (const task of tasks) {
    if (!neighbors.has(task.id)) neighbors.set(task.id, new Set());
    for (const dependency of task.depends_on) {
      if (!neighbors.has(dependency)) neighbors.set(dependency, new Set());
      neighbors.get(task.id)!.add(dependency); neighbors.get(dependency)!.add(task.id);
    }
  }
  const seen = new Set<string>(); const groups: Task[][] = []; const isolated: Task[] = [];
  for (const task of tasks) {
    if (seen.has(task.id)) continue;
    if (!neighbors.get(task.id)!.size) { seen.add(task.id); isolated.push(task); continue; }
    const group = new Set<string>(); const stack = [task.id];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); group.add(id); for (const next of neighbors.get(id) ?? []) if (!seen.has(next)) stack.push(next); }
    groups.push(tasks.filter(candidate => group.has(candidate.id)));
  }
  return <div className="dependencies-layout">{!!groups.length && <div className="dependency-groups">{groups.map(group => <DependencyComponent key={group[0].id} tasks={group} onOpen={onOpen} disabled={disabled}/>)}</div>}{!!isolated.length && <section className="isolated-section"><h3>Independent tasks <span className="muted">{isolated.length}</span></h3><div className="isolated-grid">{isolated.map(task => <button key={task.id} className="dependency-node isolated-node" disabled={disabled} onClick={() => onOpen(task.path)} title={`${task.id} ${task.title}`}><span className="node-meta">{task.id}<span className={`status-badge ${task.status}`}>{columns.find(column => column.status === task.status)?.label}</span></span><span className="node-title">{task.title}</span></button>)}</div></section>}</div>;
}
function DependencyComponent({ tasks, onOpen, disabled }: TaskViewProps) {
  if (!tasks.length) return <p className="empty-label">No tasks</p>;
  const byId = new Map(tasks.map(task => [task.id, task]));
  const ids = [...new Set(tasks.flatMap(task => [task.id, ...task.depends_on]))].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const edges = tasks.flatMap(task => [...new Set(task.depends_on)].map(from => ({ from, to: task.id })));
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  const degrees = new Map(ids.map(id => [id, 0]));
  for (const edge of edges) { outgoing.get(edge.from)!.push(edge.to); degrees.set(edge.to, degrees.get(edge.to)! + 1); }
  const levels = new Map(ids.map(id => [id, 0]));
  const queue = ids.filter(id => degrees.get(id) === 0); const processed = new Set<string>();
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]; processed.add(id);
    for (const to of outgoing.get(id)!) { levels.set(to, Math.max(levels.get(to)!, levels.get(id)! + 1)); degrees.set(to, degrees.get(to)! - 1); if (degrees.get(to) === 0) queue.push(to); }
  }
  const lastLevel = Math.max(0, ...ids.filter(id => processed.has(id)).map(id => levels.get(id)!)) + 1;
  // Cycles and their downstream nodes remain visible without recursive layout traversal.
  for (const id of ids) if (!processed.has(id)) levels.set(id, lastLevel);
  const rows = new Map<number, number>(); const positions = new Map<string, { x: number; y: number }>();
  for (const id of ids) { const level = levels.get(id)!; const row = rows.get(level) ?? 0; positions.set(id, { x: 24 + level * 260, y: 24 + row * 108 }); rows.set(level, row + 1); }
  const width = Math.max(520, 284 + Math.max(...levels.values()) * 260); const height = Math.max(170, 48 + Math.max(...rows.values()) * 108);
  return <div className="diagram-scroll" tabIndex={0} aria-label="Task dependency graph; arrows point from a dependency to the task that needs it"><div className="dependency-canvas" style={{ width, height }}>
    <svg width={width} height={height} aria-hidden="true"><defs><marker id="dependency-arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs>{edges.map(edge => {
      const a = positions.get(edge.from)!; const b = positions.get(edge.to)!; const backward = b.x <= a.x;
      const path = edge.from === edge.to ? `M${a.x + 220},${a.y + 30}C${a.x + 260},${a.y - 12} ${a.x + 260},${a.y + 98} ${a.x + 220},${a.y + 62}` : backward ? `M${a.x + 220},${a.y + 40}C${a.x + 248},${a.y + 40} ${b.x + 248},${b.y + 40} ${b.x + 220},${b.y + 40}` : `M${a.x + 220},${a.y + 40}C${a.x + 240},${a.y + 40} ${b.x - 20},${b.y + 40} ${b.x},${b.y + 40}`;
      return <path key={`${edge.from}\0${edge.to}`} d={path} fill="none" className={!processed.has(edge.from) && !processed.has(edge.to) ? 'cycle-edge' : undefined} markerEnd="url(#dependency-arrow)"/>;
    })}</svg>
    {ids.map(id => { const task = byId.get(id); const position = positions.get(id)!;
      return task ? <button key={id} className={`dependency-node ${!processed.has(id) ? 'cycle-node' : ''}`} style={{ left: position.x, top: position.y }} disabled={disabled} onClick={() => onOpen(task.path)} title={`${id} ${task.title}\nDepends on: ${task.depends_on.join(', ') || '—'}`}><span className="node-meta">{id}<span className={`status-badge ${task.status}`}>{columns.find(column => column.status === task.status)?.label}</span></span><span className="node-title">{task.title}</span></button> : <div key={id} className="dependency-node missing-node" style={{ left: position.x, top: position.y }}><span>{id}</span><span className="muted">Missing task</span></div>;
    })}
  </div>{processed.size !== ids.length && <span className="graph-warning">Cycles and the tasks after them</span>}</div>;
}
const dayMilliseconds = 86400000;
function Gantt({ tasks, onOpen, disabled }: TaskViewProps) {
  const scheduled = tasks.filter((task): task is Task & { start_date: string; end_date: string } => !!task.start_date && !!task.end_date).sort((a, b) => a.start_date.localeCompare(b.start_date) || a.id.localeCompare(b.id, 'en', { numeric: true }));
  const unscheduled = tasks.filter(task => !task.start_date || !task.end_date);
  let timeline: ReactNode = <p className="empty-label">No scheduled tasks</p>;
  if (scheduled.length) {
    const day = (value: string) => Date.parse(`${value}T00:00:00Z`) / dayMilliseconds;
    const first = Math.min(...scheduled.map(task => day(task.start_date))); const last = Math.max(...scheduled.map(task => day(task.end_date)));
    const total = last - first + 1; const pixels = Math.max(2, Math.min(36, 720 / total)); const labelWidth = 200;
    const width = Math.max(760, labelWidth + total * pixels + 24); const height = 52 + scheduled.length * 54;
    const positions = new Map(scheduled.map((task, index) => [task.id, { x: labelWidth + (day(task.start_date) - first) * pixels, end: labelWidth + (day(task.end_date) - first + 1) * pixels, y: 52 + index * 54 }]));
    const tickStep = Math.max(1, Math.ceil(85 / pixels)); const ticks = Array.from({ length: Math.ceil(total / tickStep) }, (_, index) => first + index * tickStep);
    timeline = <div className="diagram-scroll" tabIndex={0} aria-label="Task Gantt chart"><div className="gantt-canvas" style={{ width, height }}>
      {ticks.map(tick => <div className="gantt-tick" key={tick} style={{ left: labelWidth + (tick - first) * pixels, height }}><span>{new Date(tick * dayMilliseconds).toISOString().slice(0, 10)}</span></div>)}
      <svg width={width} height={height} aria-hidden="true"><defs><marker id="gantt-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7z" fill="currentColor"/></marker></defs>{scheduled.flatMap(task => [...new Set(task.depends_on)].map(id => {
        const a = positions.get(id); const b = positions.get(task.id)!; if (!a) return null;
        return <path key={`${id}\0${task.id}`} d={`M${a.end},${a.y + 15}H${a.end + 10}V${b.y + 15}H${b.x}`} markerEnd="url(#gantt-arrow)"/>;
      }))}</svg>
      {scheduled.map(task => { const position = positions.get(task.id)!; return <div key={task.id}><button className="gantt-task-label" style={{ top: position.y }} disabled={disabled} title={`${task.id} ${task.title}`} onClick={() => onOpen(task.path)}><span>{task.id}</span><span>{task.title}</span></button><button className={`gantt-bar ${task.status}`} style={{ left: position.x, top: position.y, width: Math.max(3, position.end - position.x) }} disabled={disabled} onClick={() => onOpen(task.path)} title={`${task.id} ${task.title} · ${task.start_date} → ${task.end_date}`} aria-label={`${task.id} ${task.title}, ${task.start_date} to ${task.end_date}`}><span>{task.id}</span></button></div>; })}
    </div></div>;
  }
  return <>{timeline}{!!unscheduled.length && <section className="unscheduled"><h3>Unscheduled <span className="muted">{unscheduled.length}</span></h3><ul>{unscheduled.map(task => <li key={task.path}><button disabled={disabled} onClick={() => onOpen(task.path)}><span className="task-id">{task.id}</span>{task.title}</button>{(task.start_date || task.end_date) && <span className="muted">{task.start_date ?? '—'} / {task.end_date ?? '—'}</span>}</li>)}</ul></section>}</>;
}
