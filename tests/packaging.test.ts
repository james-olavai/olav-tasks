import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { missingSdk } from '../src/agent.js';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('the agent SDKs stay optional: not installed with the package, but declared as optional peers', () => {
  for (const sdk of ['@anthropic-ai/claude-agent-sdk', '@openai/codex-sdk']) {
    assert.equal(pkg.dependencies?.[sdk], undefined, `${sdk} must not be a hard dependency (its native binary is hundreds of MB)`);
    assert.ok(pkg.peerDependencies?.[sdk], `${sdk} is declared as a peer`);
    assert.equal(pkg.peerDependenciesMeta?.[sdk]?.optional, true, `${sdk} peer is optional`);
    assert.ok(pkg.devDependencies?.[sdk], `${sdk} stays a dev dependency so tests and types work`);
  }
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), ['yaml']);
});

test('a missing SDK produces an actionable message; other errors pass through untouched', () => {
  const missing = Object.assign(new Error('Cannot find package'), { code: 'ERR_MODULE_NOT_FOUND' });
  assert.throws(() => missingSdk('@openai/codex-sdk', 'Codex')(missing), /Codex conversations need the optional package @openai\/codex-sdk.*npm install @openai\/codex-sdk/);
  const other = new Error('boom');
  assert.throws(() => missingSdk('x', 'X')(other), error => error === other);
});

test('the tarball ships the app, CLI, skills and notices, and nothing else', async () => {
  const { stdout } = await promisify(execFile)('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: process.cwd() });
  const files: string[] = JSON.parse(stdout)[0].files.map((file: { path: string }) => file.path);
  for (const required of ['package.json', 'LICENSE', 'THIRD_PARTY_NOTICES', 'README.md', 'dist/cli.js', 'dist/server.js', 'dist/web/index.html', 'skills/docs-kb/SKILL.md', 'skills/olav-tasks-report/SKILL.md']) assert.ok(files.includes(required), `missing ${required}`);
  for (const path of files) assert.match(path, /^(package\.json|LICENSE|THIRD_PARTY_NOTICES|README[^/]*\.md|dist\/|skills\/)/, `unexpected file in the package: ${path}`);
  assert.ok(!files.some(path => path.endsWith('.map')) && !files.some(path => /^(src|tests|scripts|backlog|docs|node_modules)\//.test(path)));
});
