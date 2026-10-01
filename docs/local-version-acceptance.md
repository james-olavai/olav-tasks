# 本地基础版验收

日期：2026-09-30。原生子 Agent 实现后端、前端和卸载函数；主 Agent 检查实际源码、独立复跑、检查新渲染截图并验收。olav-tasks 尚无 Git 仓库，不能提供 Git diff 或提交记录。npm 未公开发布。

## 交付

- src/tasks.ts：任务解析、诊断和仅状态写回。
- src/project-files.ts / server.ts：项目内文件 API、版本、来源和路径边界。
- web/src/App.tsx / styles/index.css：真实 Kanban、Markdown/GFM 和文件操作。
- src/skills.ts / cli.ts：显式安装/卸载；四个 skills 随包分发。
- react-markdown、remark-gfm 作为开发依赖编入网页；运行仅依赖 yaml。THIRD_PARTY_NOTICES 保留 renderer/UI 依赖及其传递依赖许可文本。

## 主 Agent 独立验证

1. `npm run typecheck` 与 `npm run build` 通过。
2. `/tmp/olav-tasks-api-check.mjs`：50 项检查通过。任务候选/普通文档、无效 YAML/block status/UTF-8、重复 ID 全部拒绝、BOM/CRLF/注释/未知字段/正文保留、冲突409、中文路径、新建保存移动删除、排除目录、symlink/越界/隐藏项、Host/Origin/contenttype、图片签名和 revision 稳定/变化。
3. `/tmp/olav-tasks-browser-check.mjs`：31 项检查通过，Chrome 实际渲染、零 pageerror。状态 select 与原生拖动、隐藏 frontmatter、编辑落盘、外部修改保留未保存输入及409、重读、GFM表格/任务列表/代码、原始HTML及危险URL不执行、相对文件链接/图片/页内链接、新建目录/文件、移动/删除确认、外部增改删、已删除文件恢复、同步失败重连、空态和诊断、1440/390无横向溢出。主 Agent 检查桌面/窄屏看板和窄屏文件截图。
4. 安装版四个 skills：主 Agent 33 项隔离检查通过，元数据解析、重复安装、修改后拒绝卸载、完整一致才卸载及不存在幂等。quick_validate.py 因本机无 PyYAML 不能运行，使用项目既有 Node YAML 静态检查，没有添加 Python 依赖。
5. 编写与整理 skills 在 `/tmp/olav-skills-use-dm8apbha` 真实使用；主 Agent 读取产物，确认 todo/in-progress 保留、发布说明没有伪造发布完成、索引不重复维护状态。规划 skill 沿用 OT-015 静态验收。
6. `npm pack --json`：17 文件、175631 字节，包含构建网页、后端、四个 skills 和许可证，不包含源码、开发依赖或 backlog。在 `/tmp/olav-tasks-package-RLt697` production-only 安装，仅 olav-tasks + yaml；静态页面、真实任务和四个 skills 列表通过，临时服务已关闭。
7. 自身项目识别 15 个任务且无诊断。真实 olav-os 安装/浏览器/重启见下方项目记录。

## olav-os 接入

- 项目根为接入的 Studio 工作区，工具安装在 `.olav-tasks/node_modules/olav-tasks`；使用独立 prefix，不加入 Studio 运行依赖，安装目录被 Git 忽略。
- 项目级 `.agents/skills/` 安装四个 skills；未改全局客户端配置。新会话才能确保客户端重新发现新 skills，当前会话 catalogue 未自动更新。
- 当前 demo 的 21 项转换为 backlog/tasks 单文件，保留原 ID、优先级、登记状态、验收和波次说明；未将波次猜成依赖 ID，未重审实现。原功能表保留，CLAUDE 与原表标明迁入项的新状态权威。其余历史条目未迁移。
- 安装版浏览器检查：21 卡、1440/390、打开真实任务、原文导航、BACKLOG 预览；新建临时 LOCAL-VERIFY-001，通过浏览器改状态，字节对照只改变 status，随后删除。无 pageerror，无遗留测试任务。
- 实际扫描 2423 项，无截断；21卡为10 todo、10 in-progress、1历史done。5份原有普通文档 YAML 格式诊断保持原文，不影响卡片。
- 服务 SIGTERM 退出并重新 `npm run tasks` 后，21原任务哈希全部一致，重新加载21卡。服务继续运行于 http://127.0.0.1:4328，仅监听 loopback。
- 项目记录：`../olav-os/dev_docs/06-local-tasks-acceptance.md`；截图在 `../olav-os/.olav-tasks/evidence/`。

## 限制

这是可用的本地基础版。文件编辑/移动/删除仅 Markdown；普通文件仅列出，目录可新建但不提供整体移动或递归删除。单文件8 MiB，扫描10,000项/64层。状态不支持 YAML block 格式。图片不支持 SVG，原始HTML不执行。2秒元数据轮询，不保证硬实时。文件冲突没有跨进程原子CAS，极短的最终核对与替换竞态仍存在。移动不自动修复引用。

安装/升级不覆盖冲突内容；卸载仅处理与当前包完整一致的目录，不自动移除旧版本或用户改动。当前版本不含云部署/认证/同步、聊天框或 SDK，未发布 registry。

检查过程中两次脚本定位问题已修正后全量重跑：Node fetch 未发送覆盖 Host，改用原生 HTTP 请求；恢复文档的文字在同一段落，改用内容匹配。不是产品问题修复。代码复核时已修复扫描排序可能遗漏 backlog、block status 替换风险、链接 hash 分流与异步刷新版本竞态。
