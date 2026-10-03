# Olav Tasks

[简体中文](README.zh-CN.md)

Olav Tasks is a local task board and Markdown workspace. Markdown files remain the source of truth, so agents and people can work with the same project files using their existing tools.

The first release includes Backlog, Kanban, Dependencies, Gantt, and Files views; Markdown planning, writing, and organization skills; and a lightweight `docs-kb` search skill. It runs as a local Node.js application and can be installed from an npm package archive. It does not provide cloud sync, authentication, a hosted service, chat, or an Agent SDK.

## Features

- View Markdown tasks in Backlog and Kanban, including dependencies and optional assignee, effort, and model profile metadata.
- See missing dependencies, dependency cycles, and tasks without explicit schedule dates. Dates are never inferred.
- Browse project files, preview Markdown and GFM, and create, move, rename, or delete Markdown files and folders.
- Edit ordinary Markdown files with version conflict detection. Valid task files are read-only in the web interface; agents update task state in the Markdown source.
- Search Markdown using `docs-kb`, with source paths, line numbers, filters, and bounded excerpts.
- Install the bundled planning, writing, organization, and docs-kb skills into an explicitly selected agent skills directory.

## Requirements

- Node.js 22.12 or later
- npm

## Run locally

From the project directory:

```bash
npm ci
npm run dev -- .
```

The development web app is served at `http://127.0.0.1:4317`; its API listens on port `4318`. The current directory is used as the project root by default. Pass another project directory after `--` to work with it instead. Set `OLAV_TASKS_WEB_PORT` or `OLAV_TASKS_API_PORT` to change the development ports.

To build and run the production-mode local app:

```bash
npm run typecheck
npm run build
npm start -- . --port 4318
```

The production-mode server requires an explicit project directory. Use `--help` or `--version` with `node dist/cli.js` for CLI details. Stop the server with Ctrl+C.

To listen on all IPv4 interfaces, explicitly pass a host and port:

```bash
node dist/cli.js /path/to/project --host 0.0.0.0 --port 4328
```

When bound to `0.0.0.0`, open the app through the machine's network address. The server checks the Host header, same-origin requests, and project paths. This mode has no login authentication; use it only on a network you trust.

## Task files and project data

Each task is a Markdown file with YAML frontmatter. The format supports `status`, `priority`, `depends_on`, and optional `assignee`, `effort`, and `model_profile` fields. See [Task file format](docs/task-format.md) for the full contract.

The web app reads and writes the selected local project directory. Agents maintain task status and dates in the source files; task cards and valid task documents are read-only in the browser. Ordinary Markdown files can be edited in the Files view. Before saving, the app checks whether the file changed externally and reports conflicts rather than silently overwriting newer content.

The file browser supports `.md` file operations. Other files may be listed but cannot be edited, moved, or deleted. Safe image previews support PNG, JPEG, GIF, WebP, and AVIF; SVG and raw HTML in Markdown are not rendered. Hidden files, `node_modules`, `dist`, `build`, `coverage`, `references`, `archive`, and `data` are skipped. Scanning is limited to 10,000 entries and 64 directory levels. Markdown files larger than 8 MiB are not opened.

The app checks file metadata every two seconds for external changes; it is not a persistent file-watching service. Moving a Markdown file does not update links that refer to it. Writes use version checks and atomic replacement for normal edit conflicts, but there is no cross-process transaction lock.

## Run an agent on a task (optional)

On a task's detail page, "用 Claude 开始" or "用 Codex 开始" starts a Claude Agent SDK or Codex SDK session in its own git worktree (`agent/<task ID>`), under `<parent dir>/.olav-tasks-state/<project>/`. Claude permission requests are approved in the page; the Codex SDK has no per-tool approval, so Codex runs unattended inside a sandbox that can write only to the task worktree, with no network; "验收通过" is the only action that sets a task to `done`; afterwards "提交到分支并清理 worktree" commits the agent's work onto `agent/<ID>` and removes the worktree directory. Merging the branch stays manual. Each uses your existing CLI login and is available only when listening on `127.0.0.1`. Map the `model_profile` tiers to model IDs with `OLAV_TASKS_MODELS='{"claude":{"fast":"…","balanced":"…","deep":"…"},"codex":{…}}'`; unset tiers use the default model. The Kanban view lists tasks whose dependencies are all done and offers "开始就绪任务" (an explicit click; at most `OLAV_TASKS_MAX_RUNS`, default 2, run at once). Claude runs may delegate to three predefined subagent roles: `explorer` (read-only search, Read/Grep/Glob only, skips CLAUDE.md), `implementer`, and `reviewer` (read-only plus Bash, which still needs your approval). Their models default to the aliases `haiku`/`sonnet`/`opus` and are overridable with `OLAV_TASKS_ROLE_MODELS='{"explorer":"…","implementer":"…","reviewer":"…"}'`; subagent activity in the log is labelled with its role and model. Nesting and concurrency follow Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` if you set them.
Cost controls (all optional, unset = no limit): `OLAV_TASKS_MAX_BUDGET_USD` and `OLAV_TASKS_MAX_TURNS` cap one Claude turn (Codex has no such option); `OLAV_TASKS_SETTING_SOURCES=project` stops the agent from loading your user-level settings and skills (default loads all sources, as the CLI does); `ENABLE_PROMPT_CACHING_1H=1` in the server's environment asks for a 1-hour prompt cache, which suits reviews that take longer than the default 5 minutes but costs more per cache write. Without `OLAV_TASKS_MODELS`, Claude tasks with a `model_profile` use the aliases `haiku`/`sonnet`/`opus`; Codex has no default model mapping. Token and cost totals per run appear in the agent panel; the cost is the SDK's local estimate (Codex reports none).
`npx tsx scripts/agent-check.ts` exercises the flow with a fake agent.

## Search project documentation

After building, search Markdown files in an explicit project directory:

```bash
node dist/cli.js docs search . "acceptance" --json
node dist/cli.js docs search . "Markdown" --status todo --limit 10
```

Search uses case-insensitive literal phrase matching and returns the first match per file with its source path and line numbers. Results can be filtered by `status`, `category`, or `doc_type`. Search reads files on demand; it does not create an index, database, or log, and does not modify source documents.

By default, at most five files are returned and combined text or JSON output is capped at 6,000 characters. Use `--limit` (1–100) and `--max-chars` (1,000–20,000) to adjust these limits. Each excerpt is at most 600 characters. If results or diagnostics are omitted because of the output budget, the response marks itself as truncated; an empty truncated result does not prove there are no matches.

The 8 MiB limit applies to local file scanning, not model input. `docs-kb` does not convert PDF or Office documents, run OCR, classify documents, or write content.

## Install the skills

List available skills and install one into an explicit agent skills directory:

```bash
node dist/cli.js skills list
node dist/cli.js skills install docs-kb --dir /path/to/agent/skills
node dist/cli.js skills install olav-tasks-plan --dir /path/to/agent/skills
```

The package includes `docs-kb`, `loop-dev`, `olav-tasks-plan`, `olav-tasks-write-markdown`, and `olav-tasks-organize-markdown`. `loop-dev` is copied from its own repository (see `skills/loop-dev/UPSTREAM.md`); Claude runs started from the web page also receive its rules as their coordinator instructions. Skill installation does not discover or change global agent configuration. Reinstalling identical content is safe; the installer refuses to overwrite different existing content or a symlink. Uninstall only removes a directory whose contents exactly match the installed skill:

```bash
node dist/cli.js skills uninstall olav-tasks-plan --dir /path/to/agent/skills
```

## Install from a package archive

Olav Tasks is not published to the public npm registry. To create and install a local package archive:

```bash
npm pack
npm install /path/to/olav-tasks-0.1.0.tgz
./node_modules/.bin/olav-tasks docs search /path/to/project "acceptance" --json
```

The archive contains the built web app, CLI, license notices, README, and skills. Running Olav Tasks does not require Python, PyYAML, a database, or Olav Studio services.

## Project documents

- [Backlog](BACKLOG.md) — development sequence and task index.
- [Product and architecture boundaries](CLAUDE.md).
- [Development collaboration](AGENTS.md).
- [Task file format](docs/task-format.md).
- [Initial code migration plan](docs/migration-plan.md).
- [Local version acceptance](docs/local-version-acceptance.md).

## First-release goal

Choose a local project directory, review its tasks in the browser, browse or edit ordinary Markdown, and use the bundled skills to write and organize project documentation. Olav Tasks runs independently; the user explicitly chooses the project directory. It has no cloud account or synchronization service, chat interface, or Agent SDK.
