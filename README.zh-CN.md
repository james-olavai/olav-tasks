# Olav Tasks

[English](README.md)

以 Markdown 为数据源的本地任务看板与文件管理工具，配套编写、整理 Markdown 与 docs-kb 检索 skills，通过一个 npm 包安装。

第一版用于管理本机现有项目，先用本项目的 `backlog/tasks/` 完成开发演示，再接入 `../olav-os`。Kanban 与文件管理读写同一批本地文件。

## 当前状态

2026-10-01：界面提供 Backlog、Kanban、Dependencies、Gantt、Files 五个图标页签。任务状态由 Agent 编辑 Markdown 维护，Kanban 和有效任务文件正文只读；普通 Markdown 可编辑保存。依赖图显示真实依赖、缺失任务及循环关系；Gantt 只展示明确填写有效 start_date 和 end_date 的任务，其他任务列为未排期，不推算日期。Backlog 表格和 Kanban 卡片展示可选的负责人、工作量、subagent 模型档位、父任务与阻塞说明；无负责人显示“未分配”，其他缺失字段显示“—”，窄屏表格支持横向滚动。

本地文件树、Markdown/GFM 预览、新建文件/文件夹、Markdown 移动/重命名/删除、版本冲突及外部变化刷新已经实现。配套规划、编写、整理、执行与 docs-kb 五个 skills。之前版本的安装及真实项目验收见 [本地版本验收](docs/local-version-acceptance.md)。npm 包尚未公开发布，包名尚未核实可用性。

## 本地开发与启动

需要 Node.js 22.12 或更新版本及 npm。开发机已用 Node.js 22.23.2 验证。

```bash
cd olav-tasks
npm install
npm run dev -- .
```

开发网页默认位于 `http://127.0.0.1:4317`，API 默认位于端口 4318。不传目录时开发入口使用调用目录；可传入其他本地项目目录。通过 `OLAV_TASKS_WEB_PORT` 与 `OLAV_TASKS_API_PORT` 调整开发端口。

构建并运行网页：

```bash
npm run typecheck
npm run build
npm start -- . --port 4318
```

生产模式默认地址为 `http://127.0.0.1:4318`。必须明确指定项目目录；`--help` 与 `--version` 可通过 `node dist/cli.js` 调用。使用终端 Ctrl+C 停止服务。

需要使用本机网卡地址访问时，显式指定监听地址：

```bash
node dist/cli.js /你的/项目目录 --host 0.0.0.0 --port 4328
```

`0.0.0.0` 表示监听所有 IPv4 网卡，浏览器使用本机实际 IP。这个模式仍校验 Host、同源 Origin 和项目路径；当前没有登录认证。

网页读取所选目录的真实任务和文件；任务状态与日期在源文件中由 Agent 维护，网页不提供任务状态或原文编辑。普通 Markdown 的文件写操作直接更新原文件；版本不一致返回冲突，不覆盖旧版本后的改动。依赖使用 package-lock.json 锁定，可用 `npm ci` 重现安装。

任务可选字段 `assignee` 使用 `human:<稳定ID>` / `agent:<稳定ID>`（ID 非空、不含空白或冒号）；`effort` 使用 S/M/L 描述工作量；`model_profile` 使用 fast/balanced/deep 提示 subagent 模型档位。三项是只读元数据，格式或枚举无效时显示任务诊断；旧任务无需补值。规划与编写 skills 只按明确用户或项目依据设置负责人和工作量，只有需要 subagent 且项目有模型映射时才设置档位，更新时保留已有字段，不猜测。模型映射由项目 `AGENTS.md` 维护（本机 olav-os 使用其根文件），不由工作量推算；未设置档位和非 subagent 工作使用会话默认模型。完整契约见 [任务文件约定](docs/task-format.md)。

可选 `parent` 是父任务 ID，`blocked_by` 是阻塞说明，均需非空。`olav-tasks tasks list /项目目录 --json` 列出只读快照；`olav-tasks tasks ready /项目目录 --json` 返回候选、排除项、诊断、revision 和 complete。扫描不完整或图无效时不返回候选。快照不占有任务，也不授权执行。

当前文件操作只支持 `.md`；普通文件在树中可见，但不提供编辑或移动/删除。安全图片支持 PNG/JPEG/GIF/WebP/AVIF，不支持 SVG；Markdown 原始 HTML 不执行。文件树跳过隐藏项、node_modules、dist、build、coverage、references、archive、data，最多扫描 10,000 项、64 层，截断会提示。Markdown 单文件上限 8 MiB。

页面每 2 秒检查文件元数据摘要，变化后刷新，不是持久文件监听服务。有未保存编辑时保留输入并提示外部变化；刷新浏览器或离开会提示。移动不自动修复引用。写前二次版本核对与原子替换处理常规编辑冲突，但外部程序在最后核对与文件替换之间写入仍有极短竞态；本版本没有跨进程文件事务锁。

## 轻量 docs-kb

构建后可直接使用：

```bash
node dist/cli.js docs search . "验收" --json
node dist/cli.js docs search . "Markdown" --status todo --limit 10
node dist/cli.js skills list
node dist/cli.js skills install docs-kb --dir /你的/Agent技能目录
```

检索要求显式项目目录和非空关键词，按忽略大小写的单行字面短语匹配，每个文件返回第一处命中，预算允许时添加前后各一行上下文。返回原文件相对路径、起止行号和匹配行号；单片段最多 600 字符且保留实际命中。`--status`、`--category` 和 `--doc-type` 分别精确筛选 frontmatter 的 `status`、`category` 和 `doc_type`，返回的长元数据值会缩短且不展开依赖数组。

每次读取 Markdown，不创建数据库、索引或日志，不修改源文档。默认最多返回 5 个文件，`--limit` 支持 1–100。文本和紧凑 JSON 的总输出默认最多 6000 字符，包含路径、元数据、诊断与末尾换行；`--max-chars` 支持 1000–20000。结果或诊断因预算省略时标记 `truncated`，不裁断 JSON 或路径。

8 MiB 是本地扫描单文件上限，不是发给 LLM 的大小。超过上限、损坏或不支持的 frontmatter 文件产生诊断；排除 .git、node_modules、dist、build、.cache 和符号链接。为了节省 token，先读检索片段，确有必要再按命中行号读取原文的小范围，而不是整份大文件。字符预算只是近似输入量，不等于固定 token 数。无结果且 `truncated` 为真时不能断言没有命中，应缩小查询或筛选范围。

`skills install` 将指定内置技能复制到显式目标下的同名目录，不会自动发现或修改全局 Agent 配置。重复安装相同内容不变，已有不同内容或符号链接时拒绝覆盖。docs-kb 安装后仍需要可用的 `olav-tasks` CLI；只有 Markdown 检索，不含 PDF/Office/OCR 转换、自动分类或文档写入。

本地 npm 包安装（不是公开 registry 安装）：

```bash
npm pack
# 在选定安装目录运行，替换下面路径为实际生成的 tarball
npm install /绝对路径/olav-tasks-0.1.0.tgz
./node_modules/.bin/olav-tasks docs search /你的/项目目录 "关键词" --json
```

网页构建产物、CLI 和 `skills/` 目录均随包分发；无需 Python、PyYAML、数据库或 Studio 服务。

## 项目规划 skill

[olav-tasks-plan](skills/olav-tasks-plan/SKILL.md) 将需求收敛为范围、任务顺序、依赖和验收条件。它使用客户端原生文件工具，不依赖 CLI 或其他 skill；要求落盘时沿用项目目录与编号，新增看板任务使用共享 Markdown 契约。

通过已有安装入口复制到显式指定的客户端 skills 根目录：

```bash
node dist/cli.js skills install olav-tasks-plan --dir /你的/Agent技能目录
node dist/cli.js skills install olav-tasks-execute --dir /你的/Agent技能目录
```

五个 skills 均随当前 npm 包分发，由客户端发现与加载，无需额外 skill 入口服务。执行 skill 在活跃代理会话中按项目权限协调原生子代理和独立 QA，不启动后台调度。

升级遇到已有不同内容时拒绝覆盖。卸载仅接受与当前包完整一致的目录；旧版本、用户修改或额外文件需自行审阅处理，不自动移除：

```bash
node dist/cli.js skills uninstall olav-tasks-plan --dir /你的/Agent技能目录
```

项目级 Codex 等客户端可使用项目 `.agents/skills/`；当前会话的技能目录在会话启动时提供，复制后可能需要新会话才能发现。不会隐式安装到全局目录。

## 文档入口

- [BACKLOG.md](BACKLOG.md)：开发顺序、任务入口和第一版验收场景。
- [CLAUDE.md](CLAUDE.md)：产品范围与长期架构边界，所有开发 Agent 均适用。
- [AGENTS.md](AGENTS.md)：开发协作、派工和验收方式。
- [任务文件约定](docs/task-format.md)：看板和 skills 共用的 Markdown 契约。
- [首批移植清单](docs/migration-plan.md)：代码来源、许可、调用边界与界面方案。

## 第一版使用目标

安装工具后，指定本地项目目录，在浏览器内查看 Kanban、浏览文件和编辑 Markdown；Agent 使用安装的 skills 写入或整理文档，页面随文件变化更新。本机 olav-os 接入入口为其 BACKLOG.md；没有云端认证或同步；可选的右侧对话栏使用运行服务的这台机器上已认证的 Claude 或 Codex SDK（用法见英文 README）。

Olav Studio 是可复用组件来源；Olav Tasks 独立运行，项目目录由用户显式选择。
