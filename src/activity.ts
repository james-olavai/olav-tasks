import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// A read-only view of what changed in the project: recent commits and uncommitted edits, from git. Nothing here writes.
// Diffs are only produced for paths that appear in these lists, so the endpoint cannot be used to read arbitrary files.

const exec = promisify(execFile);
const maxDiff = 200_000;
export type ActivityFile = { path: string; status: string };
export type ActivityCommit = { hash: string; short: string; author: string; date: string; subject: string; files: ActivityFile[]; more: number };

const git = (root: string, args: string[]) => exec('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, timeout: 8000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
const gitSafe = (root: string, args: string[]) => git(root, args).then(result => result.stdout, (error: { stdout?: string; code?: number }) => (error.stdout !== undefined && error.code === 1 ? error.stdout : undefined));

async function prefixOf(root: string): Promise<string | undefined> {
  try { return (await git(root, ['rev-parse', '--show-prefix'])).stdout.trim(); } catch { return undefined; }
}
const strip = (prefix: string, path: string) => (prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path);

export async function activity(root: string, limit = 30) {
  const prefix = await prefixOf(root);
  if (prefix === undefined) return { git: false as const };
  const branch = (await gitSafe(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() ?? '';
  const log = await gitSafe(root, ['log', `-n${limit}`, '--name-status', '--format=%x1e%H%x1f%an%x1f%aI%x1f%s', '--', '.']) ?? '';
  const commits: ActivityCommit[] = log.split('\x1e').filter(Boolean).map(record => {
    const [header, ...rest] = record.split('\n');
    const [hash, author, date, subject] = header.split('\x1f');
    const all: ActivityFile[] = rest.filter(Boolean).map(line => { const parts = line.split('\t'); return { status: parts[0][0], path: strip(prefix, parts[parts.length - 1]) }; });
    return { hash, short: hash.slice(0, 8), author, date, subject, files: all.slice(0, 20), more: Math.max(0, all.length - 20) };
  });
  const status = await gitSafe(root, ['status', '--porcelain=v1', '-z', '--untracked-files=normal', '--', '.']) ?? '';
  const tokens = status.split('\0').filter(Boolean);
  const changes: ActivityFile[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const code = tokens[i].slice(0, 2); const path = tokens[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next token is the original path
    changes.push({ status: code === '??' ? '?' : (code[1] !== ' ' ? code[1] : code[0]), path: strip(prefix, path) });
  }
  return { git: true as const, branch, commits, changes: changes.slice(0, 200), changes_total: changes.length };
}

/** The diff of one path, either its uncommitted change or what a recent commit did to it. */
export async function activityDiff(root: string, query: { path: string; commit?: string }) {
  const prefix = await prefixOf(root);
  if (prefix === undefined) throw new Error('This project is not a git repository.');
  const overview = await activity(root, 30);
  if (!overview.git) throw new Error('This project is not a git repository.');
  const target = query.path; // git resolves pathspecs relative to the working directory, which is the project root
  let text: string | undefined;
  if (query.commit) {
    if (!/^[0-9a-f]{7,40}$/.test(query.commit)) throw new Error('Invalid commit.');
    const commit = overview.commits.find(item => item.hash === query.commit || item.hash.startsWith(query.commit!));
    if (!commit || !commit.files.some(file => file.path === query.path)) throw new Error('That path is not part of a recent commit.');
    text = await gitSafe(root, ['show', '--format=', commit.hash, '--', target]);
  } else {
    const change = overview.changes.find(item => item.path === query.path);
    if (!change) throw new Error('That path has no uncommitted change.');
    if (change.status === '?') text = await gitSafe(root, ['diff', '--no-index', '--', '/dev/null', target]);
    else text = (await gitSafe(root, ['diff', 'HEAD', '--', target])) || (await gitSafe(root, ['diff', '--cached', '--', target]));
  }
  const diff = text ?? '';
  return { diff: diff.slice(0, maxDiff), truncated: diff.length > maxDiff };
}
