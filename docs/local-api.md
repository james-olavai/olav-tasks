# 本地看板 API 与交互实施契约

2026-09-30：本次实现目标，用于后端和前端分工；验收完成前不代表已交付。

所有接口同源，JSON 错误为 `{error: string}`，冲突返回 409。写请求使用 `Content-Type: application/json`；浏览器 Origin 必须来自当前本地服务或开发 Vite 源。不接受外部来源。路径均为项目根内相对路径，拒绝隐藏目录、排除目录与符号链接。

| 方法与路径 | 数据 |
|---|---|
| GET /api/project | 既有 `{name,root,version}` |
| GET /api/tree | `{entries:[{path,type:"file"或"directory"}],truncated:boolean}`；相对路径扁平列表，包含普通文件，前端构建可展开目录 |
| GET /api/tasks | `{tasks:[{path,id,title,status,priority?,parent?,blocked_by?,depends_on:string[],version}],diagnostics:[{path,message}],truncated:boolean,revision:string}`；只读展示，不授予派工权限 |
| GET /api/file?path=… | `{path,content,version}`；Markdown UTF-8，version 为原字节 SHA-256 |
| POST /api/file | `{path,content,version:null或string}`；null 新建且禁止覆盖，string 保存且核对原版本；返回文件数据 |
| PATCH /api/task | `{path,status,version}`；仅改 status，返回文件数据 |
| POST /api/directory | `{path}`；创建单层文件夹，父目录已存在；返回 `{path}` |
| POST /api/move | `{path,to,version}`；仅操作文件，不覆盖目标；返回 `{path:to,content,version,warning}` |
| DELETE /api/file | `{path,version}`；仅文件，核对版本；返回 `{path}` |
| GET /api/revision | `{revision}`；可采用文件树元数据摘要检测外部修改，前端约每 2 秒检查，变化后重读看板/文件树/当前文档 |
| GET /api/asset?path=… | 仅安全图片类型，供项目相对图片预览，路径边界同文件接口 |

文件树递归有数量上限，并说明截断；跳过隐藏项、node_modules、dist、build、coverage、references、archive、data。Markdown 大于 8 MiB 返回明确错误/诊断；请求体大小受限。状态写回保留 BOM、CRLF、注释、未知字段、正文；重复 ID 的所有候选均诊断，不任选权威。写请求串行，读取版本核对且写入前再次核对，不生成数据库或副本作为事实源。

## 交互方案

- 三列按状态分组，点击卡片进入文件视图；原生拖放加每卡状态 select，键盘无需拖动即可操作。采用 [Linear 状态分组](https://linear.app/docs/board-layout)。
- 文件树使用普通按钮与 `aria-expanded`，采用 [WAI Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/)，不声称完整 ARIA tree 键盘模型。
- 使用已有 Tabs、Button、Card。Markdown 采用 [react-markdown](https://github.com/remarkjs/react-markdown) 与 GFM，禁用原始 HTML。相对 Markdown 链接留在文件视图，图片通过受限 asset 接口。
- 加载、空态、无效任务、失败和重试显式展示。移动提示引用可能受影响，不自动修链接；删除确认。编辑未保存时保留输入，切换/重读前确认；外部变化提示，不覆盖输入。
- 窄屏三列纵向布局，文件树与预览纵向排列；所有长路径可换行，关键按钮有名称和可见焦点。

本次用户已要求前端测试，主 Agent 运行类型/构建、隔离文件与 API 检查，并用真实浏览器验证交互、桌面和窄屏渲染。
