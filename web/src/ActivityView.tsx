import { useEffect, useState } from 'react';

type Task = { id: string; title: string; path: string };
type File = { path: string; status: string };
type Commit = { hash: string; short: string; author: string; date: string; subject: string; files: File[]; more: number };
type Overview = { git: false } | { git: true; branch: string; commits: Commit[]; changes: File[]; changes_total: number };
type Selected = { path: string; commit?: string };
const labels: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '?': 'new' };
const ago = (iso: string) => {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 90) return 'just now';
  if (seconds < 5400) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 129600) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} d ago`;
};
async function get<T>(path: string): Promise<T> {
  const response = await fetch(path); const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status})`);
  return data as T;
}

// Read-only: what changed in the project, from git. People do not edit here; they ask the agent, then look here to see what it did.
export function ActivityView({ tasks }: { tasks: Task[] }) {
  const [overview, setOverview] = useState<Overview>();
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Selected>();
  const [diff, setDiff] = useState<{ text: string; truncated: boolean } | { error: string }>();
  useEffect(() => {
    let live = true;
    const load = () => get<Overview>('/api/activity').then(data => { if (live) { setOverview(data); setError(''); } }, (cause: Error) => { if (live) setError(cause.message); });
    void load(); const timer = setInterval(() => void load(), 5000);
    return () => { live = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    if (!selected) { setDiff(undefined); return; }
    let live = true; setDiff(undefined);
    get<{ diff: string; truncated: boolean }>(`/api/activity/diff?path=${encodeURIComponent(selected.path)}${selected.commit ? `&commit=${selected.commit}` : ''}`)
      .then(data => { if (live) setDiff({ text: data.diff, truncated: data.truncated }); }, (cause: Error) => { if (live) setDiff({ error: cause.message }); });
    return () => { live = false; };
  }, [selected?.path, selected?.commit]);
  const taskOf = (path: string) => tasks.find(task => task.path === path);
  const row = (file: File, commit?: string) => {
    const task = taskOf(file.path); const active = selected?.path === file.path && selected?.commit === commit;
    return <li key={`${commit ?? 'work'}:${file.path}`}><button className={`activity-file ${active ? 'on' : ''}`} onClick={() => setSelected({ path: file.path, commit })}>
      <span className={`activity-status s-${file.status === '?' ? 'new' : file.status}`} title={labels[file.status] ?? file.status}>{file.status === '?' ? 'N' : file.status}</span>
      <span className="activity-path">{file.path}</span>{task && <span className="activity-task" title={task.title}>{task.id}</span>}</button></li>;
  };
  if (error && !overview) return <p className="feedback error" role="alert">{error}</p>;
  if (!overview) return <p role="status">Loading activity…</p>;
  if (!overview.git) return <p className="empty-label">This project is not a git repository, so there is no change history to show.</p>;
  return <div className="activity">
    <div className="activity-lists">
      <h3>Uncommitted changes <span className="muted">({overview.changes_total})</span></h3>
      {overview.changes.length ? <ul className="activity-files">{overview.changes.map(file => row(file))}</ul> : <p className="empty-label">Nothing uncommitted.</p>}
      <h3>Recent commits <span className="muted">on {overview.branch || 'HEAD'}</span></h3>
      {overview.commits.length ? overview.commits.map(commit => <section key={commit.hash} className="activity-commit">
        <div className="activity-subject">{commit.subject}</div>
        <div className="muted">{commit.short} · {commit.author} · {ago(commit.date)}</div>
        <ul className="activity-files">{commit.files.map(file => row(file, commit.hash))}</ul>
        {commit.more > 0 && <p className="muted">+ {commit.more} more files</p>}
      </section>) : <p className="empty-label">No commits yet.</p>}
    </div>
    <div className="activity-diff-pane" aria-label="Diff">
      {!selected && <p className="empty-label">Select a file to see its diff.</p>}
      {selected && !diff && <p role="status">Loading diff…</p>}
      {diff && 'error' in diff && <p className="feedback error" role="alert">{diff.error}</p>}
      {diff && 'text' in diff && <><div className="muted">{selected?.path}{selected?.commit ? ` @ ${selected.commit.slice(0, 8)}` : ' (uncommitted)'}</div>
        <pre className="activity-diff">{diff.text ? diff.text.split('\n').map((line, index) => <span key={index} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>{line}{'\n'}</span>) : '(no textual changes)'}</pre>
        {diff.truncated && <p className="muted">The diff is truncated.</p>}</>}
    </div>
  </div>;
}
