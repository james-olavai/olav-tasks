# Olav Tasks

[简体中文](README.zh-CN.md)

Olav Tasks is project management where **an AI manages the project and people change it by talking to it.** The project lives in plain Markdown files; a read-only web page shows the board, and a chat dock puts you in conversation with the Claude or Codex already signed in on your machine. There is no database, no hosted service and no account.

- **Markdown is the source of truth.** Tasks are Markdown files with YAML frontmatter, in the same directory as your documents. Agents and people use the files with the tools they already have.
- **The AI operates the board.** It claims, creates, updates and validates tasks through small commands that make each change atomic and checked, and it reports to you: what needs your decision first, then risks, progress and next steps.
- **People talk, and can always see.** The page never edits tasks. You ask in the chat dock; the Activity view shows exactly what changed, from git.

It runs as a local Node.js application, works on any project directory (software or not), and is installed from an npm package archive.

## Contents

- [Run it](#run-it) · [The board](#the-board) · [Commands for the AI project manager](#commands-for-the-ai-project-manager) · [Chat dock](#chat-dock) · [Settings](#settings) · [Search](#search-project-documentation) · [Skills](#skills) · [Install](#install-from-a-package-archive) · [Project documents](#project-documents)

## Run it

Requirements: Node.js 22.12 or later, and npm.

```bash
npm ci
npm run dev -- /path/to/project     # web app on http://127.0.0.1:4317, API on 4318
```

`OLAV_TASKS_WEB_PORT` and `OLAV_TASKS_API_PORT` change the development ports. To build and run the local app:

```bash
npm run typecheck && npm run build
npm start -- /path/to/project --port 4318
```

The production server needs an explicit project directory (`--help` and `--version` work with `node dist/cli.js`). To listen on all IPv4 interfaces pass `--host 0.0.0.0`; the server checks the Host header, same-origin requests and project paths, but **has no login**, so use it only on a network you trust (see [LAN access](#lan-access-and-yolo)). `npm test` runs the unit tests and the agent check with fake agents (no network, no credentials).

## The board

Six icons in the top bar switch views; the last button opens or collapses the chat dock. Every view is read-only for tasks.

| View | Shows |
|---|---|
| Backlog | Tasks by priority with status, assignee, effort, model tier, parent, blocker, dependencies and dates |
| Kanban | To do, In progress and Done columns with the same metadata on each card |
| Dependencies | Real dependencies, missing tasks and cycles |
| Gantt | Tasks with a valid start and end date; the rest are listed as unscheduled. Dates are never inferred |
| Files | The project's files: preview Markdown and GFM, create, move, rename and delete `.md` files and folders, edit ordinary Markdown with version-conflict detection (valid task files are read-only) |
| Activity | Uncommitted changes and recent commits from git, with a coloured diff per file and the task ID beside task files. It cannot edit or undo (ask the agent, or use git) and needs the project to be inside a git repository |

Each task is a Markdown file with frontmatter: `schema: olav.tasks/v1`, `id`, `title`, `status` (`todo`, `in-progress`, `done`) and optional `priority` (P0–P2), `assignee` (`human:<id>` or `agent:<id>`), `effort` (S/M/L), `model_profile`, `depends_on`, `parent`, `blocked_by`, `start_date` and `end_date`. See [Task file format](docs/task-format.md) for the full contract. Ordinary Markdown needs no migration; only files that opt in with the schema line appear as cards, and invalid ones show up as diagnostics instead of breaking the board.

File browser details: images support PNG, JPEG, GIF, WebP and AVIF (no SVG, no raw HTML); hidden files, `node_modules`, `dist`, `build`, `coverage`, `references`, `archive` and `data` are skipped; scanning stops at 10,000 entries and 64 levels; Markdown over 8 MiB is not opened. The page polls file metadata every two seconds, not a persistent watcher. Moving a file does not update links to it. Writes use version checks and atomic replacement; two processes editing the same file are detected, but there is no cross-process transaction.

## Commands for the AI project manager

These make board changes safe for an agent to perform. The page stays read-only; people ask the agent (in the chat dock or their own agent session) and the agent runs these.

```bash
olav-tasks tasks list     /path/to/project --json   # read-only snapshot
olav-tasks tasks ready    /path/to/project --json   # todo, unblocked, dependencies done, children done
olav-tasks tasks claim    /path/to/project OT-007 --as agent:codex
olav-tasks tasks new      /path/to/project --title "Fix login" --priority P1 --depends OT-003
olav-tasks tasks validate /path/to/project          # exit 1 when the board would show diagnostics
olav-tasks tasks digest   /path/to/project          # what needs a person, overdue, stale, progress, critical path
```

- **`ready`** returns `tasks`, `excluded`, `diagnostics`, `revision` and `complete`. An incomplete scan or invalid graph returns no candidates. It is a snapshot, not a reservation or permission to execute.
- **`claim`** sets `in-progress` and the assignee in one version-checked write under a cross-process lock (kept beside the project, never inside it). It fails if the task is not ready or someone else holds it, and is idempotent for the same assignee. Use it before starting a task so two agents never take the same one.
- **`new`** allocates the next free ID in the project's dominant prefix and directory, creates the file exclusively (concurrent creators never share an ID), always quotes the title (so colons and backticks cannot break the frontmatter) and checks `--depends` and `--parent` exist.
- **`validate`** reports what the board would flag: unreadable frontmatter, duplicate IDs, missing or cyclic dependencies and parents, a truncated scan. Agents run it after editing task files.
- **`digest`** reports what waits on a person (`blocked_by`), what is overdue (`end_date` passed, not done), what is stale (in progress and untouched for 7+ days, `--stale-days N`; time comes from the task file's last git commit, else its modification time), parent progress, ready work and the critical path (the longest chain of open tasks). With diagnostics it says so first and omits ready work and the critical path.

All accept `--json`. `claim` and `new` exit non-zero when they refuse and `validate` exits 1 when it finds diagnostics; `list`, `ready` and `digest` report problems in their output and exit 0.

## Chat dock

A collapsible chat on the right talks to the **Claude Agent SDK** or the **Codex SDK** authenticated on the machine running the server (install the one you use; see [Install](#install-from-a-package-archive)). The bubble button in the top bar and the chevron in the dock open and collapse it; the icons start a new conversation, show the history and collapse it; the Claude/Codex switch applies to a new conversation, and Codex also offers a reasoning-effort picker.

- Agents work in the **project root** like a normal terminal session. Claude asks you to approve each tool call in the dock (reads are allowed); Codex runs in a sandbox that can write inside the project root and has no network.
- **YOLO** (the checkbox beside Send) bypasses every permission prompt for the next message: Claude `bypassPermissions`, Codex `danger-full-access` with network. Use it deliberately.
- The dock shows token and estimated cost totals per conversation (the cost is the SDK's local estimate, and Codex reports none), what a conversation requested, and when usage is only partially counted. Each conversation is saved under `<parent dir>/.olav-tasks-state/<project>/` (outside the project) and can be resumed.

**Conversations start as the project manager.** Each new conversation begins with the working rules (the Claude system prompt; the first message for Codex, which has none) and, in the first message only, a brief: the project's `PROJECT.md` (if present, capped at 6,000 characters), board counts, what is in progress, what is ready, and what waits on a person. The log still shows only what you typed. The rules tell the agent to use the commands above, change status only on verified facts and record the evidence, ask you for decisions instead of making them, and tell you first what is waiting on you.

Put your goals, priorities, definition of done, working agreements and a dated decision log in **`PROJECT.md`** at the project root; the agent follows it and keeps the decision log current. `OLAV_TASKS_PM_CONTEXT=0` starts plain conversations instead.

### LAN access and YOLO

Agents run with the logins of the machine hosting the server. With `--host 0.0.0.0` the page has no login, so anyone who can reach it can drive the agents. `OLAV_TASKS_AGENT_LAN=0` restricts agents to the machine running the server. YOLO is stricter: it is accepted only from that machine unless `OLAV_TASKS_ALLOW_LAN_YOLO=1`, because on an unauthenticated page it amounts to remote code execution.

## Settings

All optional; unset means the stated default.

| Variable | Effect |
|---|---|
| `OLAV_TASKS_PM_CONTEXT=0` | Start plain conversations (no project-manager rules or brief) |
| `OLAV_TASKS_AGENT_LAN=0` | Agents only from the machine running the server |
| `OLAV_TASKS_ALLOW_LAN_YOLO=1` | Allow YOLO from other machines |
| `OLAV_TASKS_MAX_BUDGET_USD`, `OLAV_TASKS_MAX_TURNS` | Cap one Claude turn (Codex has no such option); unset = no limit |
| `OLAV_TASKS_SETTING_SOURCES=project` | Stop the agent loading your user-level settings and skills (`user,project,local` or `none`; default loads all sources, as the CLI does) |
| `OLAV_TASKS_EFFORT='{"claude":"high","codex":"high"}'` | Main agent reasoning effort. Claude unset = SDK default; Codex defaults to `medium` (Sol's own default is `low`) |
| `OLAV_TASKS_ROLE_MODELS`, `OLAV_TASKS_ROLE_EFFORT` | Subagent models and effort per role (JSON by role name) |
| `ENABLE_PROMPT_CACHING_1H=1` | In the server's environment: ask for a 1-hour prompt cache; suits slow reviews but costs more per cache write |
| `OLAV_TASKS_CHECK_TIMEOUT_MS` | Timeout for a task's `check:` command (default 120000) |

Claude conversations may delegate to four predefined subagents: `explorer` (read-only search, skips CLAUDE.md), `researcher` (web search and fetch plus read-only file tools, to check whether a library or open-source implementation already exists before building; generic technical queries only; each web call needs your approval), `implementer` and `reviewer` (read-only plus Bash, which still needs your approval). Defaults are `haiku` for the explorer, `sonnet` for the researcher and implementer, `opus` for the reviewer, all at `medium` effort. Their activity is labelled with role and model in the log; nesting and concurrency follow Claude Code's `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` and `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS`. Codex has no subagent roles.

### Earlier task runs

Tasks can no longer be started as separate runs from the page or the API; conversations start in the chat dock. A run created by an earlier version stays reviewable on its task's detail page: the server runs the task's optional `check:` command itself in the run's worktree (one line, exit 0 = green, evidence only), you can view the diff, "Accept (mark done)" is the only action that sets a task to `done`, and "Commit to branch and clean up worktree" commits onto `agent/<task ID>` and removes the worktree (merging stays manual). The check runs with a timeout, in its own process group, with `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` and `OPENROUTER_API_KEY` removed from its environment, and the command is read from the task file in the project root. Only put a command in `check:` that you trust to run on your machine.

## Search project documentation

```bash
node dist/cli.js docs search . "acceptance" --json
node dist/cli.js docs search . "Markdown" --status todo --limit 10
```

Search uses case-insensitive literal phrase matching and returns the first match per file with its source path and line numbers; results can be filtered by `status`, `category` or `doc_type` frontmatter. It reads files on demand and creates no index, database or log. By default at most five files are returned and combined output is capped at 6,000 characters (`--limit` 1–100, `--max-chars` 1,000–20,000; each excerpt is at most 600 characters). If anything is omitted the response says it is truncated; an empty truncated result does not prove there are no matches. The 8 MiB limit applies to local scanning, not model input. `docs-kb` does not convert PDF or Office documents, run OCR, classify documents or write content.

## Skills

Six skills are bundled; an agent client discovers and loads them, with no skill service to run.

| Skill | Use it to |
|---|---|
| `olav-tasks-plan` | Turn an idea or requirement into scope, priorities, dependencies and verifiable tasks |
| `olav-tasks-write-markdown` | Write or update project Markdown and task files in the existing format and numbering |
| `olav-tasks-organize-markdown` | Tidy directory entry points, indexes and duplicates, or split a backlog into tasks |
| `olav-tasks-execute` | Pick ready tasks and run implementation, independent QA, repair (two rounds at most) and acceptance with native subagents in an active session; it starts no background worker |
| `olav-tasks-report` | Turn `tasks digest` into a report: decisions needed first, then risks, progress and next steps, checked against facts |
| `docs-kb` | Search project Markdown and locate passages by path and line before answering or writing |

```bash
node dist/cli.js skills list
node dist/cli.js skills install olav-tasks-plan --dir /path/to/agent/skills
node dist/cli.js skills uninstall olav-tasks-plan --dir /path/to/agent/skills
```

Installation needs an explicit directory and never touches global agent configuration. Reinstalling identical content is safe; the installer refuses to overwrite different content or a symlink, and uninstall only removes a directory that exactly matches the installed skill.

## Install from a package archive

Olav Tasks is not published to the public npm registry. To create and install a local archive:

```bash
npm pack
npm install /path/to/olav-tasks-0.1.0.tgz
./node_modules/.bin/olav-tasks tasks ready /path/to/project --json
```

The archive contains the built web app, the CLI, license notices, this README and the skills (about 220 kB; installing it adds one dependency, `yaml`). Running Olav Tasks needs no Python, database or other service.

**The chat dock needs an agent SDK, which is optional.** The Claude and Codex SDKs bundle native binaries (about 235 MB and 430 MB), so they are optional peer dependencies and are not installed with Olav Tasks. Install the one you use next to Olav Tasks (add `-g` if Olav Tasks is installed globally), then start a new conversation; they use the logins you already have:

```bash
npm install @anthropic-ai/claude-agent-sdk   # Claude conversations
npm install @openai/codex-sdk                # Codex conversations
```

Without it the board, CLI and skills work normally, and a conversation fails with a message that names the package to install. The Claude Agent SDK is Anthropic software under Anthropic's own terms (not MIT), which is another reason it is opt-in.

## Project documents

- [Backlog](BACKLOG.md): development sequence and task index.
- [Development rules, product scope and boundaries](AGENTS.md): the single rules file for every development agent. `CLAUDE.md` only imports it, so Claude Code and Codex read the same content.
- [Task file format](docs/task-format.md).
- [Initial code migration plan](docs/migration-plan.md).
- [Local version acceptance](docs/local-version-acceptance.md).
