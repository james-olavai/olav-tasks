#!/usr/bin/env node
import { realpath, stat, readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { parseArgs } from 'node:util';
import { localIPv4Addresses, startServer } from './server.js';
import { formatSearchResult, searchDocs } from './docs-kb.js';
import { installSkill, listSkills, uninstallSkill } from './skills.js';
import { ProjectFiles } from './project-files.js';
import { taskReadiness } from './task-readiness.js';
import { claimTask, newTask, validateProject } from './pm-tools.js';

async function tasksCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' },
    as: { type: 'string' }, title: { type: 'string' }, priority: { type: 'string' }, depends: { type: 'string' },
    parent: { type: 'string' }, dir: { type: 'string' }, prefix: { type: 'string' }, body: { type: 'string' },
  }, allowPositionals: true });
  const usage = 'Usage: olav-tasks tasks list <project-directory> [--json]\n       olav-tasks tasks ready <project-directory> [--json]\n       olav-tasks tasks claim <project-directory> <task-ID> --as <human:ID|agent:ID> [--json]\n       olav-tasks tasks new <project-directory> --title <text> [--priority P0|P1|P2] [--depends A,B] [--parent ID] [--dir <relative dir>] [--prefix PFX] [--body <text>] [--json]\n       olav-tasks tasks validate <project-directory> [--json]\nlist and ready are read-only snapshots; ready is not an execution reservation. claim atomically sets in-progress and the assignee, and fails if the task is not ready or is held by someone else. new allocates the next free ID. validate exits 1 when the board would show diagnostics.';
  if (values.help) { console.log(usage); return; }
  const [sub, dir, id] = positionals;
  if (!['list', 'ready', 'claim', 'new', 'validate'].includes(sub) || !dir || (sub === 'claim' ? positionals.length !== 3 : positionals.length !== 2)) throw new Error(`Invalid tasks command.\n${usage}`);
  const root = await realpath(dir);
  if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory.');
  if (sub === 'claim') {
    if (!values.as) throw new Error('claim needs --as <human:ID|agent:ID>.');
    const result = await claimTask(root, id, values.as);
    console.log(values.json ? JSON.stringify(result) : `${result.already ? 'Already claimed' : 'Claimed'} ${result.id} for ${result.assignee} (${result.path})`);
    return;
  }
  if (sub === 'new') {
    const result = await newTask(root, { title: values.title ?? '', priority: values.priority, depends: values.depends?.split(',').map(item => item.trim()).filter(Boolean), parent: values.parent, dir: values.dir, prefix: values.prefix, body: values.body });
    console.log(values.json ? JSON.stringify(result) : `Created ${result.id} (${result.path})`);
    return;
  }
  if (sub === 'validate') {
    const result = await validateProject(root);
    if (values.json) console.log(JSON.stringify(result));
    else console.log(result.ok ? `OK: ${result.tasks} tasks, no diagnostics.` : `${result.diagnostics.length} diagnostics${result.truncated ? ', scan truncated' : ''}:\n${result.diagnostics.map(item => `${item.path}: ${item.message}`).join('\n')}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }
  const listing = await new ProjectFiles(root).tasks();
  const result = sub === 'ready' ? taskReadiness(listing) : listing;
  if (values.json) { console.log(JSON.stringify(result)); return; }
  if (sub === 'ready') {
    const ready = result as ReturnType<typeof taskReadiness>;
    console.log(ready.complete ? ready.tasks.map(task => `${task.id}\t${task.path}\t${task.title}`).join('\n') || 'No ready tasks.' : 'Task scan or graph is incomplete; no tasks are ready.');
  } else console.log(listing.tasks.map(task => `${task.id}\t${task.status}\t${task.path}\t${task.title}`).join('\n') || 'No tasks.');
  if (result.diagnostics.length) console.error(result.diagnostics.map(item => `${item.path}: ${item.message}`).join('\n'));
  if (listing.truncated) console.error('Task scan was truncated.');
}

async function docsCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, options: {
    help: { type: 'boolean', short: 'h' }, status: { type: 'string' }, category: { type: 'string' },
    'doc-type': { type: 'string' }, limit: { type: 'string' }, 'max-chars': { type: 'string' }, json: { type: 'boolean' },
  }, allowPositionals: true });
  if (values.help) { console.log('Usage: olav-tasks docs search <project-directory> <literal query> [--status s] [--category c] [--doc-type t] [--limit 1-100] [--max-chars 1000-20000] [--json]\nCase-insensitive phrase per line. Multiple query arguments join with one space. Returns first context per file. Defaults: 5 files, 600 characters per excerpt, 6000 characters total output.'); return; }
  if (positionals[0] !== 'search') throw new Error('Unknown docs command. Use docs search --help.');
  if (positionals.length < 3) throw new Error('Specify a project directory and nonempty literal query. Use docs search --help.');
  const limitText = values.limit ?? '5';
  const limit = Number(limitText);
  if (!/^\d+$/.test(limitText) || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Limit must be an integer between 1 and 100.');
  const maxCharsText = values['max-chars'] ?? '6000';
  const maxChars = Number(maxCharsText);
  if (!/^\d+$/.test(maxCharsText) || !Number.isInteger(maxChars) || maxChars < 1000 || maxChars > 20000) throw new Error('max-chars must be an integer between 1000 and 20000.');
  const result = await searchDocs({ root: positionals[1], query: positionals.slice(2).join(' '), limit, status: values.status, category: values.category, docType: values['doc-type'] });
  process.stdout.write(formatSearchResult(result, Boolean(values.json), maxChars));
}
async function skillsCommand(args: string[]) {
  const { values, positionals } = parseArgs({ args, options: { help: { type: 'boolean', short: 'h' }, dir: { type: 'string' } }, allowPositionals: true });
  if (values.help) { console.log('Usage: olav-tasks skills list\n       olav-tasks skills install <name> --dir <skills-root>\n       olav-tasks skills uninstall <name> --dir <skills-root>\nExplicit destination required. Identical installs are unchanged; conflicts are rejected.'); return; }
  if (positionals[0] === 'list' && positionals.length === 1 && values.dir === undefined) { console.log((await listSkills()).join('\n')); return; }
  if (positionals[0] !== 'install' && positionals[0] !== 'uninstall') throw new Error('Unknown skills command. Use skills --help.');
  if (positionals.length !== 2 || !values.dir?.trim()) throw new Error('Specify one bundled skill and an explicit --dir destination.');
  if (positionals[0] === 'uninstall') { const result = await uninstallSkill(positionals[1], values.dir); console.log(`Uninstalled: ${positionals[1]} → ${result.destination}`); return; }
  const result = await installSkill(positionals[1], values.dir);
  console.log(`${result.changed ? 'Installed' : 'Already identical'}: ${result.name} → ${result.destination}`);
}
async function main() {
  if (process.argv[2] === 'docs') return docsCommand(process.argv.slice(3));
  if (process.argv[2] === 'skills') return skillsCommand(process.argv.slice(3));
  if (process.argv[2] === 'tasks') return tasksCommand(process.argv.slice(3));
  const { values, positionals } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
    port: { type: 'string', short: 'p' }, host: { type: 'string' },
  }, allowPositionals: true });
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  if (values.help) {
    console.log('Olav Tasks\n\nUsage: olav-tasks <project-directory> [--port 4318] [--host 127.0.0.1|0.0.0.0]\n       olav-tasks tasks --help\n       olav-tasks docs search --help\n       olav-tasks skills --help\n\n  -h, --help     Show help\n  -v, --version  Show version\n  -p, --port     HTTP port (default 4318)\n      --host     Listen address: 127.0.0.1 or 0.0.0.0 (default 127.0.0.1)\n\nUse --host 0.0.0.0 to allow access through this machine’s IPv4 interfaces.');
    return;
  }
  if (values.version) { console.log(pkg.version); return; }
  if (positionals.length !== 1) throw new Error('Specify exactly one project directory. Use --help for usage.');
  const port = Number(values.port ?? process.env.OLAV_TASKS_API_PORT ?? '4318');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Port must be an integer between 1 and 65535.');
  const host = values.host ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '0.0.0.0') throw new Error('Host must be 127.0.0.1 or 0.0.0.0.');
  let root: string;
  try { root = await realpath(positionals[0]); } catch { throw new Error('Project directory does not exist or cannot be accessed.'); }
  if (!(await stat(root)).isDirectory()) throw new Error('Project path must be a directory.');
  const server = await startServer({ root, name: basename(root) || root, version: pkg.version, port, host });
  const addresses = host === '0.0.0.0' ? [...new Set(['127.0.0.1', ...localIPv4Addresses()])] : ['127.0.0.1'];
  console.log(`Olav Tasks listening on ${host}:${port}\n${addresses.map(address => `http://${address}:${port}`).join('\n')}\nProject: ${root}`);
  let stopping = false;
  const shutdown = () => {
    if (stopping) return;
    stopping = true;
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    const timeout = setTimeout(() => { server.closeAllConnections(); process.exit(0); }, 3000);
    timeout.unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
main().catch((error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(`Olav Tasks: ${code === 'EADDRINUSE' ? 'Port is already in use. Choose another with --port.' : error instanceof Error ? error.message : 'Unable to start.'}`);
  process.exitCode = 1;
});
