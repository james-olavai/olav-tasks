import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';

export type SearchOptions = { root: string; query: string; status?: string; category?: string; docType?: string; limit: number };
type Metadata = Record<string, string | number | boolean | null | (string | number | boolean | null)[]>;
type Diagnostic = { path: string; code: string; message: string };
type Match = { path: string; startLine: number; endLine: number; matchLine: number; snippet: string; metadata: Metadata };
const excluded = new Set(['.git', 'node_modules', 'dist', 'build', '.cache']);
const maxBytes = 8 * 1024 * 1024;
function inside(root: string, path: string) {
  const rel = relative(root, path);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
function metadataFrom(lines: string[]): Metadata {
  const first = lines[0]?.replace(/^\uFEFF/, '');
  if (first !== '---') return {};
  const end = lines.findIndex((line, index) => index > 0 && (line === '---' || line === '...'));
  if (end < 0) throw new Error('Frontmatter has no closing delimiter.');
  const doc = parseDocument(lines.slice(1, end).join('\n'), { strict: true, uniqueKeys: true });
  if (doc.errors.length) throw new Error('Frontmatter contains invalid YAML or duplicate keys.');
  if (!isMap(doc.contents)) throw new Error('Frontmatter must be a mapping.');
  for (const pair of doc.contents.items) if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Frontmatter keys must be text.');
  const metadata: Metadata = {};
  const scalar = (node: unknown) => {
    if (!isScalar(node)) throw new Error('Selected metadata must use plain scalar values.');
    const value: unknown = node.value;
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string' && value.length <= 512) return value;
    throw new Error('Selected metadata has an unsupported or oversized value.');
  };
  for (const key of ['schema', 'id', 'title', 'status', 'category', 'doc_type', 'priority', 'depends_on']) {
    const node = doc.get(key, true);
    if (node === undefined) continue;
    if (key === 'depends_on') {
      if (!isSeq(node) || node.items.length > 100) throw new Error('depends_on must be an array with at most 100 scalars.');
      metadata[key] = node.items.map(scalar);
    } else metadata[key] = scalar(node);
  }
  return metadata;
}
function excerpt(lines: string[], index: number, hit: number, hitLength: number) {
  const line = lines[index];
  let content = line;
  if (line.length > 600) {
    // Reserve both ellipses so the actual literal match always fits the 600-character cap.
    const from = Math.max(0, hit - Math.floor((598 - hitLength) / 2));
    const to = Math.min(line.length, from + 598);
    content = `${from > 0 ? '…' : ''}${line.slice(from, to)}${to < line.length ? '…' : ''}`;
  }
  let start = index;
  let end = index;
  if (index > 0 && lines[index - 1].length + 1 + content.length <= 600) {
    content = `${lines[index - 1]}\n${content}`;
    start--;
  }
  if (index + 1 < lines.length && content.length + 1 + lines[index + 1].length <= 600) {
    content += `\n${lines[index + 1]}`;
    end++;
  }
  return { snippet: content, startLine: start + 1, endLine: end + 1 };
}
function displayMetadata(metadata: Metadata) {
  const projected: Metadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (key === 'depends_on') continue;
    projected[key] = typeof value === 'string' && value.length > 80 ? `${value.slice(0, 79)}…` : value;
  }
  return projected;
}
export async function searchDocs(options: SearchOptions) {
  const root = await realpath(options.root).catch(() => { throw new Error('Project directory does not exist or cannot be accessed.'); });
  if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory.');
  if (!options.query.trim() || options.query.length > 512) throw new Error('Query must contain text and be at most 512 characters.');
  const query = options.query;
  const literal = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const matches: Match[] = [];
  const diagnostics: Diagnostic[] = [];
  let scannedFiles = 0;
  let truncated = false;
  const diagnostic = (path: string, code: string, message: string) => {
    if (diagnostics.length < 10) diagnostics.push({ path, code, message }); else truncated = true;
  };
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { diagnostic(relative(root, directory) || '.', 'read-directory', 'Unable to read directory.'); return; }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const full = resolve(directory, entry.name);
      const path = relative(root, full).split(sep).join('/');
      try {
        const info = await lstat(full);
        if (info.isSymbolicLink()) continue;
        const actual = await realpath(full);
        if (!inside(root, actual)) { diagnostic(path, 'outside-root', 'Path resolves outside the project.'); continue; }
        if (info.isDirectory()) { if (!excluded.has(entry.name)) await walk(actual); continue; }
        if (!info.isFile() || !/\.md$/i.test(entry.name)) continue;
        scannedFiles++;
        if (info.size > maxBytes) { diagnostic(path, 'file-too-large', 'Markdown exceeds the 8 MiB search limit.'); continue; }
        const buffer = await readFile(actual);
        if (buffer.length > maxBytes) { diagnostic(path, 'file-too-large', 'Markdown exceeds the 8 MiB search limit.'); continue; }
        const lines = buffer.toString('utf8').split(/\r\n|\n|\r/);
        let metadata: Metadata;
        try { metadata = metadataFrom(lines); }
        catch { diagnostic(path, 'invalid-frontmatter', 'Invalid, duplicate, unsupported, or oversized frontmatter metadata; file skipped.'); continue; }
        if ((options.status !== undefined && metadata.status !== options.status) ||
            (options.category !== undefined && metadata.category !== options.category) ||
            (options.docType !== undefined && metadata.doc_type !== options.docType)) continue;
        const index = lines.findIndex(line => literal.test(line));
        if (index < 0) continue;
        if (matches.length >= options.limit) { truncated = true; continue; }
        const hit = literal.exec(lines[index])!;
        matches.push({ path, ...excerpt(lines, index, hit.index, hit[0].length), matchLine: index + 1, metadata: displayMetadata(metadata) });
      } catch { diagnostic(path, 'read-file', 'Unable to read this path.'); }
    }
  };
  await walk(root);
  return { root, query, scannedFiles, matches, diagnostics, truncated };
}

export function formatSearchResult(result: Awaited<ReturnType<typeof searchDocs>>, asJson: boolean, maxChars: number) {
  const output = { ...result, matches: [...result.matches], diagnostics: [...result.diagnostics] };
  const render = () => {
    if (asJson) return `${JSON.stringify(output)}\n`;
    const lines = [`Project: ${output.root}`, `Query: ${output.query}`, `Scanned Markdown files: ${output.scannedFiles}`];
    for (const match of output.matches) lines.push(`\n${match.path}:${match.startLine}-${match.endLine} (match line ${match.matchLine})\n${match.snippet}`);
    if (!output.matches.length) lines.push(result.matches.length ? 'No match excerpts fit the output budget.' : 'No matches.');
    for (const item of output.diagnostics) lines.push(`Diagnostic: ${item.path} [${item.code}] ${item.message}`);
    if (output.truncated) lines.push('Output truncated; narrow the query or filters.');
    return `${lines.join('\n')}\n`;
  };
  let text = render();
  while (text.length > maxChars && output.diagnostics.length) {
    output.diagnostics.pop(); output.truncated = true; text = render();
  }
  while (text.length > maxChars && output.matches.length) {
    output.matches.pop(); output.truncated = true; text = render();
  }
  if (text.length > maxChars) throw new Error('Root and query exceed the output budget. Use a shorter query or larger --max-chars.');
  return text;
}
