import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);
const apiPort = process.env.OLAV_TASKS_API_PORT ?? '4318';
const env = { ...process.env, OLAV_TASKS_API_PORT: apiPort };
// Development defaults to the invocation directory; production requires an explicit root.
const root = args[0] ?? process.env.INIT_CWD ?? process.cwd();
if (args.length > 1 || root.startsWith('-')) { console.error('Usage: npm run dev -- [project-directory]. Configure ports with OLAV_TASKS_API_PORT and OLAV_TASKS_WEB_PORT.'); process.exit(1); }
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 4000);
  timer.unref();
}
for (const [entry, argv] of [['tsx/dist/cli.mjs', ['src/cli.ts', resolve(root)]], ['vite/bin/vite.js', []]]) {
  const child = spawn(process.execPath, [resolve(packageRoot, 'node_modules', entry), ...argv], { cwd: packageRoot, env, stdio: 'inherit' });
  children.push(child);
  child.on('error', () => { console.error('Unable to start development tools. Run npm install first.'); stop(1); });
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
