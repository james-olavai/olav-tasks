# Olav Tasks 开发 Backlog

建立日期：2026-09-30。第一版目标：独立 npm 安装的本地 Kanban、文件管理、编写与整理 Markdown skills 及 docs-kb 检索，并能管理本机现有项目。

本地基础版本已接通真实看板与 Markdown 文件操作、外部变化刷新、四个 skills 和显式安装入口。任务当前状态以各任务文件 frontmatter 为唯一来源；验证范围和限制见 docs/local-version-acceptance.md。

## 开发顺序

1. 工程骨架与组件移植核对。
2. Markdown 契约、项目目录读取与文件写入。
3. 文件界面、Kanban 和外部更新联动。
4. 编写、整理和 docs-kb skills 与显式安装入口。
5. npm 打包验收与本地真实项目验收。

先跑通任务文件读写与文件服务契约，再拆分不冲突的前端和 skills 工作。移植已有 UI 组件先调查依赖和许可。

## 任务索引

| ID | 优先级 | 任务 | 依赖 |
|---|---|---|---|
| OT-001 | P0 | [独立 npm 工程与开发入口](backlog/tasks/OT-001.md) | — |
| OT-002 | P0 | [核对 Studio 组件移植边界](backlog/tasks/OT-002.md) | OT-001 |
| OT-003 | P0 | [Markdown 任务解析与状态写回](backlog/tasks/OT-003.md) | OT-001 |
| OT-004 | P0 | [本地项目与文件服务](backlog/tasks/OT-004.md) | OT-001、OT-003 |
| OT-005 | P0 | [文件树、Markdown 预览与编辑](backlog/tasks/OT-005.md) | OT-002、OT-004 |
| OT-006 | P0 | [Kanban 与拖动状态更新](backlog/tasks/OT-006.md) | OT-002、OT-003、OT-004 |
| OT-007 | P1 | [外部文件变化与冲突恢复](backlog/tasks/OT-007.md) | OT-004、OT-005、OT-006 |
| OT-008 | P1 | [编写 Markdown skill](backlog/tasks/OT-008.md) | OT-003 |
| OT-013 | P1 | [docs-kb Markdown 检索与长文定位](backlog/tasks/OT-013.md) | OT-001 |
| OT-014 | P1 | [收紧 docs-kb 输出以减少 LLM token](backlog/tasks/OT-014.md) | OT-013 |
| OT-015 | P1 | [精简项目规划 skill](backlog/tasks/OT-015.md) | OT-001 |
| OT-016 | P1 | [显式绑定所有 IPv4 网卡](backlog/tasks/OT-016.md) | OT-011、OT-012 |
| OT-017 | P1 | [任务负责人、工作量与 subagent 模型档位](backlog/tasks/OT-017.md) | OT-003、OT-006、OT-008、OT-015 |
| OT-018 | P1 | [原生代理开发闭环与任务就绪查询](backlog/tasks/OT-018.md) | OT-017 |
| OT-019 | P1 | [Codex 聊天恢复与用量完整性](backlog/tasks/OT-019.md) | — |
| OT-020 | P1 | [最小上下文派工与消耗分项](backlog/tasks/OT-020.md) | OT-019 |
| OT-009 | P1 | [整理 Markdown skill](backlog/tasks/OT-009.md) | OT-003、OT-013 |
| OT-010 | P1 | [skills 安装入口](backlog/tasks/OT-010.md) | OT-001、OT-008、OT-009、OT-013、OT-015 |
| OT-011 | P1 | [npm 包安装与启动验收](backlog/tasks/OT-011.md) | OT-005、OT-006、OT-007、OT-010 |
| OT-012 | P1 | [管理自身 backlog 与本机真实项目](backlog/tasks/OT-012.md) | OT-011 |

## 第一版验收场景

1. 在独立临时目录用本地 npm tarball 安装工具，指定项目根目录并打开网页，无需运行 Studio。
2. 指定本项目目录：识别 `backlog/tasks/` 中的任务；README 等普通 Markdown 仍可正常浏览，不成为卡片。
3. 打开卡片看到原文；拖动卡片后原文件状态变化，正文不变；重启服务后状态仍正确。
4. 通过文件管理新建、编辑、重命名、移动文档及删除测试文件，磁盘内容与界面一致。
5. 外部编辑 Markdown 后界面更新；编辑冲突有明确恢复操作，没有静默覆盖。
6. 安装配套 skills 到指定 Agent 目录，用 docs-kb 从项目 Markdown 中检索并定位原文，再用真实 Agent 编写一份任务文档和整理一份索引，看板与文件视图显示文件变化。此项通过 Agent 现有工具完成，不需要聊天栏或 SDK。
7. 接入用户选择的现有本机项目；`../olav-os` 是首个候选。先验证浏览，整理仅新增索引和任务入口；现有移动、删除等操作不作为自动导入步骤。

实际检查命令、截图和结果在执行任务时补充；这份场景清单不等于已经验证通过。

## 后续候选

聊天栏与 Agent SDK、多项目总览、更多 Agent skill 安装目标、列配置与卡片排序，以及 docs-kb 的 PDF/Office/OCR 导入，在第一版完成后按真实使用需求另立任务。第一版不预建相关运行模块。
