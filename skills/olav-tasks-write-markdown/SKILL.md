---
name: olav-tasks-write-markdown
description: 在用户选定项目中编写或更新 Markdown 文档与 Olav Tasks 任务文件，沿用已有格式、编号和引用。
---

# 编写项目 Markdown

使用客户端原生文件工具。按需读取项目协作规范、目标文件和相关模板；先定位相关内容，避免整份加载大文档。

- 根据用户要求写计划、说明、进度或成果。普通文档沿用项目格式，不强加任务字段。
- 新增看板任务使用下列契约；ID 沿用项目编号规则且唯一，先检查现有任务，避免重复。

```yaml
---
schema: olav.tasks/v1
id: TASK-001
title: "可验收的交付"
status: todo
priority: P1
assignee: agent:codex # 可选，仅有明确归属时设置
effort: M # 可选，仅有工作量依据时设置
model_profile: balanced # 可选，仅需 subagent 且项目有模型映射时设置
depends_on: []
---
```

`assignee` 可选，格式为 `human:<稳定ID>` 或 `agent:<稳定ID>`，例如 `human:alice`、`agent:codex`；ID 非空且不含空白或冒号。`effort` 可选，取 S/M/L，只描述工作量。仅在用户或项目上下文确切时设置，缺少依据就省略，不猜测或为旧任务批量补值。示例字段仅演示格式。

`model_profile` 可选，取 fast/balanced/deep，是 subagent 模型档位提示，不改变 assignee，也不由 effort 推算。只有需要派 subagent 且项目 `AGENTS.md` 有模型映射时才填写；派工先检查映射模型是否可用，未明确档位或非 subagent 工作沿用当前会话默认模型。

正文写目标、范围与可观察的验收条件。priority 可省略或使用 P0/P1/P2；depends_on 可省略或填写真实任务 ID。目录由项目决定，无约定时可用 backlog/tasks/；索引使用相对链接，不重复维护状态。

更新前读取现有文件；保留稳定 ID、assignee、effort、model_profile、未知字段、无关正文与有效引用。若读取后文件发生变化，重新读取并合并，不以旧内容覆盖。

状态仅使用 todo、in-progress、done。只有实际开始执行才记 in-progress，只有验收依据满足条件才记 done，并在正文记录结果和限制；方案或代码存在不等于验收完成。任务状态由执行 Agent 根据真实进展维护，网页任务视图只读。既有其他任务格式保留原样，转换需属于用户要求。

不得擅自更换已有任务的负责人、工作量或模型档位；仅按用户明确要求或已确认项目依据修改，网页仍只读展示这些元数据。

结束时列出实际改动文件与尚未核实的内容；写文档本身不启动实现、发布或外部消息发送。

可选 `start_date`、`end_date` 仅在计划明确时写入真实 YYYY-MM-DD 日期，结束不得早于开始；不猜日期，缺少日期保持未排期。
