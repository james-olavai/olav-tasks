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

## Chat dock (optional)

A collapsible chat on the right of every page (open or collapse it with the bubble button in the centred tab group of the top bar, or the chevron in the dock) talks to the Claude Agent SDK or Codex SDK authenticated on the machine running the server. The icons start a new conversation, show the history, and collapse the dock; the Claude/Codex switch applies to a new conversation. Agents work in the project root like a normal terminal session: Claude asks you to approve each tool call in the dock (reads are allowed), Codex runs in a sandbox that can write inside the project root and has no network. The **YOLO** option next to Send bypasses every permission prompt for the next message (Claude `bypassPermissions`; Codex `danger-full-access` with network). 

## Agent settings and earlier task runs

Conversations start in the chat dock above; tasks can no longer be started as separate runs from the page or the API. A run created by an earlier version (stored under `<parent dir>/.olav-tasks-state/<project>/`) stays reviewable on its task's detail page: the server runs the task's optional `check:` command itself in the run's worktree (single line, exit 0 = green; it never changes status), you can view the diff, "Accept (mark done)" is the only action that sets a task to `done`, and "Commit to branch and clean up worktree" commits the work onto `agent/<task ID>` and removes the worktree (merging stays manual). The check runs with a timeout (`OLAV_TASKS_CHECK_TIMEOUT_MS`, default 120000), in its own process group, with `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`CODEX_API_KEY`/`OPENROUTER_API_KEY` removed from its environment, and the command is read from the task file in the project root. Only put a command in `check:` that you trust to run on your machine.

Claude conversations may delegate to four predefined subagent roles: `explorer` (read-only search, Read/Grep/Glob only, skips CLAUDE.md), `researcher` (web search/fetch plus read-only file tools, for loop-dev's prior-art step; generic technical queries only; each web call needs your approval), `implementer`, and `reviewer` (read-only plus Bash, which still needs your approval). Their models default to `haiku` (explorer), `sonnet` (researcher, implementer) and `opus` (reviewer) and are overridable with `OLAV_TASKS_ROLE_MODELS='{"explorer":"…","researcher":"…","implementer":"…","reviewer":"…"}'`; every role runs at `medium` reasoning effort unless `OLAV_TASKS_ROLE_EFFORT='{"explorer":"low",…}'` says otherwise. The main agent's effort is `OLAV_TASKS_EFFORT='{"claude":"high","codex":"high"}'` (Claude unset = SDK default; Codex defaults to `medium`, since Sol's own default is `low`); Codex has no subagent roles. Subagent activity in the log is labelled with its role and model; nesting and concurrency follow Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` / `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` if you set them.

Cost controls (all optional, unset = no limit): `OLAV_TASKS_MAX_BUDGET_USD` and `OLAV_TASKS_MAX_TURNS` cap one Claude turn (Codex has no such option); `OLAV_TASKS_SETTING_SOURCES=project` stops the agent from loading your user-level settings and skills (default loads all sources, as the CLI does); `ENABLE_PROMPT_CACHING_1H=1` in the server's environment asks for a 1-hour prompt cache, which suits reviews that take longer than the default 5 minutes but costs more per cache write. Token and cost totals per conversation appear in the dock; the cost is the SDK's local estimate (Codex reports none). Agents are usable from any machine that can reach the page: with `--host 0.0.0.0` the page has no login, so anyone on the LAN can drive the agents running with your local logins. Set `OLAV_TASKS_AGENT_LAN=0` to restrict agents to the machine running the server. YOLO is stricter: it is accepted only from that machine unless `OLAV_TASKS_ALLOW_LAN_YOLO=1`, because on an unauthenticated page it amounts to remote code execution.

`npx tsx scripts/agent-check.ts` exercises all of this with fake agents (no network, no credentials).

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
