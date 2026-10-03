# Olav Tasks — 产品与架构边界

本文件适用于所有开发 Agent。任务进度查 `BACKLOG.md` 及其链接的任务文件。

## 已确认的产品范围

- 名称为 Olav Tasks；目录为 `olav-tasks`。npm 包候选名与 CLI 候选入口均为 `olav-tasks`，发布前确认名称可用性。
- 第一版：Kanban、文件管理、规划/编写/整理 Markdown skills，以及 docs-kb 的 Markdown 检索与长文定位能力，通过一个 npm 包分发。2026-09-30 补入轻量 docs-kb 与规划 skill，范围为 Node 本地检索及显式目录 skill 安装；交付状态见对应任务。
- 第一版验收包含本机真实项目管理：先管理本项目，再由用户选择现有项目目录接入。
- 2026-10-03 用户授权最小版开发聊天：任务详情内嵌 Agent 面板，经 Claude Agent SDK 为每个任务起一个会话（`src/agent.ts`），仅 loopback，权限请求由网页逐条批准；每个任务一个 git worktree 与 `agent/<ID>` 分支，运行记录存于项目外的 `<父目录>/.olav-tasks-state/<项目名>/`；面板可看分支 diff，`done` 仍只由人点“验收通过”设置，验收后可提交到分支并清理 worktree，分支合并仍是手动；每次运行记录 token 与估算费用，可选预算/回合上限；Claude 运行预置 explorer/implementer/reviewer 三个子 agent 角色（各自固定档位与工具白名单），日志按角色和模型标注；任务可带可选 `check` 命令，服务端在每回合后于 worktree 内独立运行并显示红绿（仅作验收证据，不改状态）。随包分发 `loop-dev` skill（来源见 `skills/loop-dev/UPSTREAM.md`，以上游仓库为准），网页启动的 Claude 运行以它为协调规则；已接入 Claude 与 Codex 两个适配器（Codex 无逐条批准，靠只写 worktree、禁网的沙箱）；pi 适配、测试输出面板仍留到后续版本。
- 不引入工单系统；第一版无组织、岗位、招聘、审批工作流或云同步。

## 架构原则

- Markdown 是任务与文档的唯一事实源。看板与文件管理是同一目录的两种视图，任务状态回写原文件。
- 本地服务读取用户显式选定的项目根目录，默认仅监听 loopback。跨目录访问、符号链接逃逸、浏览器任意来源写入等边界在文件服务中落实。
- 普通 Markdown 无需迁移或补字段；只有明确符合任务文件契约的文件进入看板。未知字段和正文不得因拖动或编辑被静默丢弃。
- 与编辑器或 Agent 并发修改时检测冲突并提供重新读取，不能静默覆盖外部更新。
- npm 包包含构建后的网页、本地服务、CLI 与 skills；运行不依赖 Olav Studio、OpenOPC、Bun 或用户机器上的参考克隆。
- npm 安装负责分发 skills 文件；独立的显式 CLI 操作将 skills 安装到支持的 Agent 发现目录。目标目录、覆盖与卸载规则需在实现任务中明确。
- 整理已有项目以新增索引与任务入口为起点；不自动批量搬动文件、重命名或重写既有文档。

## 开发基线与待核实项

以下是本项目的初始实施基线，不代表功能已实现：

- Node.js 本地服务与 CLI；React + Vite + TypeScript 网页，按需复用 Studio 的 shadcn/Radix 组件与视觉 token。
- 一张卡片对应一个带 YAML frontmatter 的 Markdown 文件；默认状态为 `todo`、`in-progress`、`done`，契约见 `docs/task-format.md`。
- 项目通过 CLI 参数选择；第一版每次管理一个根目录，可分别启动多个项目。

开工前核实 Node 支持版本、组件移植依赖、Markdown 渲染方案、监听方式和首个 skill 安装目标。方案选择记录到对应任务，不把候选写成已交付能力。
