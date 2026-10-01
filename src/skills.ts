import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, copyFile } from 'node:fs/promises';
import { basename, dirname, parse, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRoot = fileURLToPath(new URL('../skills', import.meta.url));
async function noSymlinkAncestors(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, segment);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw new Error('Skill destination must not contain symbolic links.');
      if (!info.isDirectory()) throw new Error('Skill destination must be a directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}
async function bundleFiles(root: string, prefix = ''): Promise<Map<string, Buffer>> {
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Skill bundle must be a directory without symbolic links.');
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    const key = prefix ? `${prefix}/${entry.name}` : entry.name;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error('Skill bundle must not contain symbolic links.');
    if (info.isDirectory()) { files.set(`${key}/`, Buffer.alloc(0)); for (const [name, body] of await bundleFiles(path, key)) files.set(name, body); }
    else if (info.isFile()) files.set(key, await readFile(path));
    else throw new Error('Skill bundle contains an unsupported filesystem entry.');
  }
  return files;
}
export async function listSkills() {
  const rootInfo = await lstat(bundledRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Bundled skills directory is unavailable.');
  const names: string[] = [];
  for (const entry of await readdir(bundledRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const files = await bundleFiles(resolve(bundledRoot, entry.name));
    if (files.has('SKILL.md')) names.push(entry.name);
  }
  return names.sort();
}
export async function installSkill(name: string, directory: string) {
  if (!(await listSkills()).includes(name)) throw new Error('Unknown bundled skill. Run skills list.');
  const root = resolve(directory);
  const destination = resolve(root, name);
  await noSymlinkAncestors(destination);
  const source = resolve(bundledRoot, name);
  const files = await bundleFiles(source);
  const exists = await lstat(destination).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (exists) {
    const current = await bundleFiles(destination);
    if (current.size === files.size && [...files].every(([path, body]) => current.get(path)?.equals(body))) {
      return { name, destination, changed: false };
    }
    throw new Error('Destination contains conflicting contents; existing skill was not overwritten.');
  }
  await mkdir(root, { recursive: true });
  await noSymlinkAncestors(root);
  const stage = await mkdtemp(resolve(root, `.${basename(name)}-`));
  try {
    for (const path of files.keys()) {
      const target = resolve(stage, path);
      if (path.endsWith('/')) { await mkdir(target, { recursive: true }); continue; }
      await mkdir(dirname(target), { recursive: true });
      await copyFile(resolve(source, path), target);
    }
    await noSymlinkAncestors(destination);
    if (await lstat(destination).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; })) throw new Error('Destination appeared during installation; existing contents were preserved.');
    await rename(stage, destination);
  } finally { await rm(stage, { recursive: true, force: true }); }
  return { name, destination, changed: true };
}

/** Remove only an unchanged copy of a currently bundled skill. */
export async function uninstallSkill(name: string, directory: string) {
  if (!(await listSkills()).includes(name)) throw new Error('Unknown bundled skill. Run skills list.');
  const root = resolve(directory);
  const destination = resolve(root, name);
  await noSymlinkAncestors(destination);
  const exists = await lstat(destination).then(() => true, error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  });
  if (!exists) return { name, destination, changed: false };

  const expected = await bundleFiles(resolve(bundledRoot, name));
  const current = await bundleFiles(destination);
  if (current.size !== expected.size || ![...expected].every(([path, body]) => current.get(path)?.equals(body))) {
    throw new Error('Destination differs from the current bundled skill; existing contents were not removed.');
  }
  // Recheck the path immediately before removal; do not traverse a replaced symlink.
  await noSymlinkAncestors(destination);
  await rm(destination, { recursive: true });
  return { name, destination, changed: true };
}
