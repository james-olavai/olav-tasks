import { constants, type Dirent } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, rename, unlink, link } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isTaskStatus, parseTask, replaceTaskStatus, setTaskField, type Task } from './tasks.js';

export class ApiError extends Error { constructor(public status: number, message: string) { super(message); } }
const excluded = new Set(['node_modules', 'dist', 'build', 'coverage', 'references', 'archive', 'data']);
const maxSize = 8 * 1024 * 1024;
function utf8(body: Buffer) { try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body); } catch { throw new ApiError(415, 'Markdown must contain valid UTF-8 text.'); } }
const hash = (body: Buffer | string) => createHash('sha256').update(body).digest('hex');
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
export function validatePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 4096 || isAbsolute(value) || value.includes('\\') || value.includes('\0')) throw new ApiError(400, 'Use a nonempty project-relative path.');
  const parts = value.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.') || excluded.has(part) || part.includes(':'))) throw new ApiError(403, 'Hidden, excluded, or escaping paths are not allowed.');
  return value;
}
function markdown(path: string) { if (extname(path).toLowerCase() !== '.md') throw new ApiError(415, 'This operation supports Markdown (.md) files only.'); }
function validVersion(value: unknown): string { if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) throw new ApiError(400, 'A valid file version is required.'); return value; }
function translate(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') throw new ApiError(404, 'Path does not exist.');
  if (code === 'EEXIST' || code === 'ENOTEMPTY') throw new ApiError(409, 'Destination already exists.');
  if (code === 'EACCES' || code === 'EPERM') throw new ApiError(403, 'Filesystem access denied.');
  if (code === 'ELOOP') throw new ApiError(403, 'Symbolic links are not allowed.');
  if (code === 'ENOTDIR' || code === 'EISDIR') throw new ApiError(400, 'Path has the wrong file type.');
  throw error;
}
export class ProjectFiles {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private async path(value: unknown, missing = false) {
    const path = validatePath(value);
    let current = this.root;
    const parts = path.split('/');
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      if (!inside(this.root, current)) throw new ApiError(403, 'Path is outside the project.');
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) throw new ApiError(403, 'Symbolic links are not allowed.');
        if (index < parts.length - 1 && !info.isDirectory()) throw new ApiError(400, 'Parent must be a directory.');
        if (!inside(this.root, await realpath(current))) throw new ApiError(403, 'Path resolves outside the project.');
      } catch (error) {
        if (missing && index === parts.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return { path, full: current };
        translate(error);
      }
    }
    return { path, full: current };
  }
  private serial<T>(operation: () => Promise<T>) {
    const next = this.queue.then(operation).catch(translate);
    this.queue = next.catch(() => {});
    return next;
  }
  private async bytes(value: unknown) {
    const { path, full } = await this.path(value);
    const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW).catch(translate);
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new ApiError(400, 'Path must be a regular file.');
      if (info.size > maxSize) throw new ApiError(413, 'File exceeds the 8 MiB limit.');
      // Bounded reads remain bounded even if an external editor grows the file after stat.
      const body = Buffer.alloc(Math.min(info.size + 1, maxSize + 1));
      let count = 0;
      while (count < body.length) { const read = await file.read(body, count, body.length - count, count); if (!read.bytesRead) break; count += read.bytesRead; }
      if (count > maxSize) throw new ApiError(413, 'File exceeds the 8 MiB limit.');
      return { path, full, body: body.subarray(0, count), mode: info.mode };
    } finally { await file.close(); }
  }
  async read(value: unknown) {
    const path = validatePath(value); markdown(path);
    const file = await this.bytes(path);
    const content = utf8(file.body); const version = hash(file.body);
    let isTask = false;
    try { isTask = parseTask(content, path, version).task !== null; } catch { /* Invalid task candidates remain readable for diagnosis. */ }
    return { path, content, version, isTask };
  }
  private async check(path: string, version: string) {
    const file = await this.bytes(path);
    if (hash(file.body) !== version) throw new ApiError(409, 'File changed externally. Reload before saving.');
    return file;
  }
  async scan() {
    const entries: { path: string; type: 'file' | 'directory' }[] = [];
    const diagnostics: { path: string; message: string }[] = [];
    const digest = createHash('sha256');
    let truncated = false; let visited = 0;
    const walk = async (directory: string, depth: number): Promise<void> => {
      if (depth > 64) { truncated = true; return; }
      let stream;
      try { stream = await opendir(directory); }
      catch { if (diagnostics.length < 100) diagnostics.push({ path: relative(this.root, directory), message: 'Cannot read directory.' }); return; }
      const children: Dirent[] = [];
      for await (const entry of stream) {
        if (entry.name.startsWith('.') || excluded.has(entry.name) || entry.isSymbolicLink()) continue;
        children.push(entry);
        if (children.length > 10000) { truncated = true; break; }
      }
      const priority = (entry: typeof children[number]) => entry.name === 'backlog' && entry.isDirectory() ? 0 : entry.name === 'tasks' && entry.isDirectory() ? 1 : /\.md$/i.test(entry.name) ? 2 : entry.isDirectory() ? 4 : 3;
      children.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name, 'en'));
      for (const entry of children) {
        if (++visited > 10000) { truncated = true; break; }
        const full = resolve(directory, entry.name);
        const path = relative(this.root, full).split(sep).join('/');
        try {
          const info = await lstat(full, { bigint: true });
          if (info.isSymbolicLink() || !inside(this.root, await realpath(full))) continue;
          if (!info.isDirectory() && !info.isFile()) continue;
          entries.push({ path, type: info.isDirectory() ? 'directory' : 'file' });
          digest.update(`${path}\0${info.size}\0${info.mtimeNs}\0${info.ctimeNs}\0${info.ino}\n`);
          if (info.isDirectory()) await walk(full, depth + 1);
          if (truncated && visited > 10000) break;
        } catch { if (diagnostics.length < 100) diagnostics.push({ path, message: 'Cannot inspect path.' }); }
      }
    };
    await walk(this.root, 0);
    entries.sort((a, b) => a.path.localeCompare(b.path));
    if (truncated) diagnostics.push({ path: '.', message: 'Directory scan reached the 10,000-entry or 64-level limit.' });
    return { entries, diagnostics, truncated, revision: digest.digest('hex') };
  }
  async tasks() {
    const scan = await this.scan();
    const diagnostics = [...scan.diagnostics];
    const candidates: Task[] = [];
    for (const entry of scan.entries) {
      if (entry.type !== 'file' || !/\.md$/i.test(entry.path)) continue;
      try {
        const file = await this.read(entry.path);
        const parsed = parseTask(file.content, entry.path, file.version);
        if (parsed.task) candidates.push(parsed.task);
      } catch (error) { if (diagnostics.length < 500) diagnostics.push({ path: entry.path, message: error instanceof Error ? error.message : 'Cannot parse file.' }); }
    }
    const counts = new Map<string, number>();
    for (const task of candidates) counts.set(task.id, (counts.get(task.id) ?? 0) + 1);
    const tasks = candidates.filter(task => {
      if (counts.get(task.id)! > 1) { diagnostics.push({ path: task.path, message: `Duplicate task ID: ${task.id}` }); return false; }
      return true;
    });
    return { tasks, diagnostics, truncated: scan.truncated, revision: scan.revision };
  }
  save(value: unknown, content: unknown, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      if (typeof content !== 'string') throw new ApiError(400, 'content must be text.');
      const body = Buffer.from(content, 'utf8');
      if (body.length > maxSize) throw new ApiError(413, 'Markdown exceeds the 8 MiB limit.');
      if (version === null) {
        const { full } = await this.path(path, true);
        const file = await open(full, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        try { await file.writeFile(body); } finally { await file.close(); }
      } else await this.replace(path, body, validVersion(version));
      return this.read(path);
    });
  }
  private async replace(path: string, body: Buffer, version: string) {
    const original = await this.check(path, version);
    const temporary = resolve(dirname(original.full), `.olav-tasks-${randomUUID()}.tmp`);
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, original.mode & 0o777);
      try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
      await this.check(path, version);
      await this.path(path);
      await rename(temporary, original.full);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  updateStatus(value: unknown, status: unknown, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      if (!isTaskStatus(status)) throw new ApiError(400, 'Invalid task status.');
      const expected = validVersion(version);
      const original = await this.check(path, expected);
      const listed = await this.tasks();
      if (!listed.tasks.some(task => task.path === path)) throw new ApiError(400, 'Task is invalid, duplicated, or outside the bounded scan.');
      const content = replaceTaskStatus(utf8(original.body), status);
      await this.replace(path, Buffer.from(content, 'utf8'), expected);
      return this.read(path);
    });
  }
  // Status and assignee change in ONE write, guarded by the version the caller read, so a concurrent edit is detected instead of overwritten.
  claim(value: unknown, assignee: string, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      const expected = validVersion(version);
      const original = await this.check(path, expected);
      let content: string;
      try { content = setTaskField(replaceTaskStatus(utf8(original.body), 'in-progress'), 'assignee', assignee); } catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Invalid task file.'); }
      await this.replace(path, Buffer.from(content, 'utf8'), expected);
      return this.read(path);
    });
  }
  setMeta(value: unknown, field: 'assignee' | 'model_profile', text: unknown, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      if (typeof text !== 'string') throw new ApiError(400, `${field} must be text.`);
      const expected = validVersion(version);
      const original = await this.check(path, expected);
      let content: string;
      try { content = setTaskField(utf8(original.body), field, text); } catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Invalid task field.'); }
      await this.replace(path, Buffer.from(content, 'utf8'), expected);
      return this.read(path);
    });
  }
  directory(value: unknown) {
    return this.serial(async () => { const { path, full } = await this.path(value, true); await mkdir(full); return { path }; });
  }
  move(value: unknown, to: unknown, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      const destination = validatePath(to); markdown(destination);
      if (path === destination) throw new ApiError(400, 'Source and destination must differ.');
      const expected = validVersion(version);
      const source = await this.check(path, expected);
      const target = await this.path(destination, true);
      await this.check(path, expected);
      await this.path(path);
      // link refuses existing targets and preserves bytes; unlink is performed only after rechecking.
      await link(source.full, target.full);
      try { await this.check(path, expected); await unlink(source.full); }
      catch (error) { await unlink(target.full).catch(() => {}); throw error; }
      return { ...(await this.read(destination)), warning: 'Moving a file may affect relative links. References were not automatically updated.' };
    });
  }
  remove(value: unknown, version: unknown) {
    return this.serial(async () => {
      const path = validatePath(value); markdown(path);
      const expected = validVersion(version);
      const file = await this.check(path, expected);
      await this.check(path, expected); await this.path(path);
      await unlink(file.full); return { path };
    });
  }
  async asset(value: unknown) {
    const path = validatePath(value);
    const types: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif' };
    const type = types[extname(path).toLowerCase()];
    if (!type) throw new ApiError(415, 'Only PNG, JPEG, GIF, WebP, and AVIF images are supported.');
    const file = await this.bytes(path);
    const b = file.body;
    const valid = type === 'image/png' ? b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) : type === 'image/jpeg' ? b[0] === 255 && b[1] === 216 && b[2] === 255 : type === 'image/gif' ? /^GIF8[79]a/.test(b.subarray(0,6).toString('ascii')) : type === 'image/webp' ? b.subarray(0,4).toString() === 'RIFF' && b.subarray(8,12).toString() === 'WEBP' : b.subarray(4,8).toString() === 'ftyp' && /avif|avis/.test(b.subarray(8,32).toString());
    if (!valid) throw new ApiError(415, 'Image signature does not match the supported type.');
    return { body: b, type };
  }
}
