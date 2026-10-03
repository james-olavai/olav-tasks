# Markdown 任务文件约定

这是本地版任务契约，用于本项目 backlog、Kanban 及配套规划、编写、整理与检索 skills。任务解析已实现，状态由 Agent 编辑 Markdown 维护；网页只读展示任务。状态 API 保留用于后续工具调用，网页不调用它；检索仍独立读取文档元数据。

## 识别与字段

仅将 YAML frontmatter 中 `schema: olav.tasks/v1` 的 `.md` 文件作为任务候选；校验通过才显示为卡片。其他 Markdown 作为普通文档展示。候选任务无效时显示文件级错误，不使整个目录不可用。

```markdown
---
schema: olav.tasks/v1
id: OT-001
title: 建立独立 npm 项目骨架
status: todo
priority: P0
assignee: agent:codex
effort: M
model_profile: balanced
depends_on: []
---

## 目标

正文记录任务说明、范围和验收条件。
```

| 字段 | 约定 |
|---|---|
| `schema` | 必填，固定为 `olav.tasks/v1`，表示明确加入看板 |
| `id` | 必填，项目内唯一且稳定；改标题、移动文件不改变 ID |
| `title` | 必填，非空字符串，显示为卡片标题 |
| `status` | 必填，`todo` / `in-progress` / `done`，显示为待办 / 进行中 / 完成 |
| `priority` | 可选，`P0` / `P1` / `P2`；用于开发排序，不增加状态列 |
| `assignee` | 可选，`human:<稳定ID>` / `agent:<稳定ID>`，例如 `human:alice`、`agent:codex`；ID 非空，不含空白或冒号，不关联成员目录或账号 |
| `effort` | 可选，`S` / `M` / `L`，描述工作量，不表示难度或模型能力 |
| `model_profile` | 可选，`fast` / `balanced` / `deep`，作为 subagent 派工的模型档位提示，不改变负责人 |
| `check` | 可选，单行 shell 命令（至多 500 字符）；退出码 0 表示机器可判定的验收通过。Agent 面板在每个回合后于该任务的 worktree 里独立运行它，结果只是证据，不改变状态；命令只从项目根目录的任务文件读取，不读 worktree 里的副本 |
| `depends_on` | 可选，任务 ID 数组；依赖图显示真实关系、缺失 ID 与循环，不自动调度 |
| `start_date` | 可选，严格 `YYYY-MM-DD` 的有效日历日期 |
| `end_date` | 可选，严格 `YYYY-MM-DD` 的有效日历日期；与开始日期同时存在时不得早于开始日期 |

示例中的协作字段仅演示格式；无确定依据时省略，不写空字符串或 YAML null。三项字段均为纯元数据，旧任务不必补填。已设置字段的格式或枚举无效时返回任务诊断。

负责人和工作量仅在用户或项目上下文明确时设置。需要派 subagent 且项目有明确模型映射时才设置 `model_profile`；派工按项目 `AGENTS.md` 的映射选模型，并先检查可用性，缺少档位或非 subagent 工作使用当前会话默认模型。本机 olav-os 的映射由其根 `AGENTS.md` 维护，工具不内置模型列表，也不按 `effort` 推算档位。不为旧任务猜测或批量补值；更新时保留已有负责人、工作量和模型档位，变更需有明确依据。

ID 重复与无法解析的任务文件显示诊断，不选择其中一份作为权威。保留未识别 frontmatter 字段；任务正文可自由编写。

`status` 支持普通、单引号或双引号 YAML 字符串；不支持 YAML block literal/folded 表示，返回诊断，避免状态写回损坏格式。Markdown 必须为有效 UTF-8，可带 BOM 和 CRLF。

## 状态更新与链接

- Agent 只有确认真实执行进展或完成验收时才更新 `status`，规划保持原状态。网页 Kanban 不拖动、不改状态（唯一例外：任务详情里的 Agent 面板会在开始时把 `todo` 改为 `in-progress` 并在未设置时写入 `assignee: agent:claude`，可选择 `model_profile`，人工点“验收通过”才写 `done`）；有效任务文件只预览正文，不提供原文编辑或保存入口。普通 Markdown 仍支持编辑和保存。
- 日期只在计划明确时由 Agent 写入，不猜测、不从依赖或状态推算。Gantt 仅展示同时具备有效开始与结束日期的任务；缺少任一日期时进入“未排期”列表。完全无日期时显示空时间轴和未排期任务。
- Backlog 表格和 Kanban 卡片显示负责人、工作量与模型档位；未设置负责人显示“未分配”，其余显示“—”。这些字段在网页只读，不触发自动分派或状态更新。
- Backlog 按优先级、ID、路径稳定排序，Dependencies 的箭头由依赖任务指向被依赖约束的任务。各视图点击任务均打开原 Markdown。
- 写入前核对读取版本；外部更新时报告冲突并重新读取。文件操作在根目录边界内进行。
- 文档链接使用相对路径。移动或重命名之前提示可能影响的引用；无法可靠扫描时说明检查范围，不能声称所有链接已修复。
- 普通文件目录和任务文件位置由项目决定，不强制创建专用任务目录。本项目将开发任务放在 `backlog/tasks/`。
- `BACKLOG.md` 是索引与计划，不复制任务状态；卡片状态以任务文件为准。
