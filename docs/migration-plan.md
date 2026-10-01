# 首批组件移植与交互方案

日期：2026-09-30。首轮交付范围是工程与网页外壳，不把原 Studio 工单、Drive API 或身份系统搬入。任务数据、文件管理和 skills 按 backlog 后续任务接入。

## 来源与依赖

代码来源仓库：`../olav-os`；下表路径均相对该仓库，运行时不依赖它。

| 来源文件 | 本项目目标 | 处理与依赖 |
|---|---|---|
| `experiments/t-37-human-ai-swarm-skeleton/web/src/components/ui/button.tsx` | `web/src/components/ui/button.tsx` | 搬入；React、Radix Slot、class-variance-authority、cn |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/components/ui/card.tsx` | `web/src/components/ui/card.tsx` | 搬入；React、cn |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/components/ui/tabs.tsx` | `web/src/components/ui/tabs.tsx` | 搬入；React、Radix Tabs、cn |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/lib/utils.ts` | `web/src/lib/utils.ts` | 搬入；clsx、tailwind-merge |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/styles/index.css` | `web/src/styles/index.css` | 复用语义 token 与基础层；Tailwind 与动画 CSS，控制额外本地布局样式 |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/features/drive/drive-tree.tsx` | 后续目录树 feature | 只参考交互，暂不复制：依赖 DriveEntry、fetchDriveList、ApiError、ContextMenu、ScrollArea、toast 及大量文件操作回调 |
| `experiments/t-37-human-ai-swarm-skeleton/web/src/features/drive/markdown-editable-preview.tsx` | 后续 Markdown feature | 只参考保存与预览流程，暂不复制：依赖 TipTap 完整编辑器、Drive API、useEditableDriveFile 与 Studio renderer 注册/工单逻辑 |

首轮搬入文件保留原仓库 MIT 许可与署名。仓库根 LICENSE 是 `Copyright (c) 2026 olav-os contributors`；本项目 LICENSE 和 THIRD_PARTY_NOTICES 须保留对应许可。shadcn 上游 MIT 许可也随 notices 保留。未复制第三方业务页面或品牌资产。

## 调用边界

当前骨架：CLI 验证用户指定目录 → 本地 Node HTTP 服务 → 项目信息接口 → 网页外壳。网页生产资源随 npm 包分发，开发时 Vite 同源代理本地 API。

后续流程：本地服务提供目录、Markdown 与任务接口；Kanban 和文件视图共用文件选择和读取版本。原 Studio 的 `/work/api`、登录头、组织 ID、工单和运行调度调用全部替换为本工具项目根目录内的文件接口。

## 界面与参考模式

用户从顶部“看板 / 文件”入口切换视图，选中的文件在内容区打开。窄屏切换为纵向结构，顶部入口保持可见。

- 看板按状态分三列，参考 [Linear board layout](https://linear.app/docs/board-layout) 的状态分组行为；字段及列固定遵循本项目任务契约。
- 视图切换复用现有 Radix Tabs / shadcn 组件，参考 [shadcn Tabs](https://v3.shadcn.com/docs/components/tabs)；保留方向键切换、焦点样式和正确 tabpanel 语义。
- 文件树参考 Studio 已有展开、选择与当前路径行为；后续实施时使用展开按钮的 `aria-expanded`、可访问名称和正确选中反馈。
- 构建最低 Node 版本设为 22.12，满足 [Vite 官方要求](https://vite.dev/guide/)；开发机当前为 Node 22.23.2。

## 状态与后续验收

外壳加载真实项目信息；加载、网络失败及重试均显式展示。尚未接入的数据视图以开发预览说明展示，不能使用模拟卡片声称管理了本地文件。

后续实际功能页：无任务时提供创建入口；目录读取失败保留当前位置并允许重试；保存成功显示反馈，冲突保留输入并允许重新读取；删除确认后才写磁盘。拖动之外提供键盘可操作的状态选择。移动/重命名报告链接影响范围，不承诺自动修复所有引用。

首轮验证独立构建、CLI 参数错误与端口冲突、生产启动和项目信息读取，以及桌面/窄屏外壳。文件操作、拖动、监听与 skills 验收属于后续任务，不以本次外壳验收替代。
