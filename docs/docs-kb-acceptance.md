# 轻量 docs-kb 验收

日期：2026-09-30。范围为 OT-013 的 Node Markdown 检索、docs-kb skill 与本地 npm 分发。实现由原生子 Agent 完成，主 Agent 阅读实际源文件并独立验证。

> 同日 OT-014 增补已收紧输出预算；下文初次验收中的默认 20 文件、前后两行是历史值。现行值为默认 5 文件、单片段最多 600 字符、前后各一行（预算允许时）、总 stdout 默认 6000 字符。文本与紧凑 JSON 均受 `--max-chars` 控制，参数范围 1000–20000；结果省略时标记 truncated。Skill 改为按原行号局部读取，避免整份大文件读取。验收细节见 [OT-014](../backlog/tasks/OT-014.md)。

## 交付接口

```bash
olav-tasks docs search <项目目录> "字面短语" --json
olav-tasks skills list
olav-tasks skills install docs-kb --dir <Agent技能目录>
```

查询忽略大小写，每个文件第一处匹配返回最多前后两行，长行会裁剪。精选元数据可按 status/category/doc_type 精确筛选。JSON 包含 root/query/scannedFiles/matches/diagnostics/truncated，结果含 path/startLine/endLine/matchLine/snippet/metadata。

Markdown 读取上限 8 MiB；大文件返回诊断。默认 20 个结果、最大 100 个。没有数据库、索引写入、Python 或 OCR。Skill 安装要求用户指定目标，不覆盖冲突内容，不自动写全局配置。

## 实际验证

- npm build 与 typecheck 通过。
- 隔离样例覆盖：约 250 KiB 的长 Markdown 在第 2346 行定位命中；BOM/CRLF 原始第 6 行；普通任务和文档元数据筛选；大小写 .MD 与中文字样；句点按字面匹配。
- 默认排除 .git/node_modules/dist/build/.cache；项目外文件/目录 symlink 不被读取。超过 8 MiB 与重复 YAML 键产生诊断，不影响有效文件。
- 无命中、结果上限、缺参数、空关键词、无效 limit、不存在项目、缺技能目标目录等行为符合文档。
- 搜索前后原始文件 SHA256 一致。未产生源文档重写或 npm 包目录日志。
- Skill 安装创建完整目录；相同重复安装不变；用户编辑后的冲突及目标 symlink 被拒绝。Node 校验 skill frontmatter 与必备字段通过。官方 Python 校验器因本机无 PyYAML 未能运行，没有安装额外 Python 依赖。
- npm tarball 清单包含 dist、网页资源、许可证、README 与 skills/docs-kb/SKILL.md；不包含源码、backlog、node_modules 或临时验证目录。
- 临时独立 consumer 使用 `npm install --omit=dev --ignore-scripts` 安装本地包：只安装 olav-tasks 和 yaml。通过已安装 bin 查询同一示例、安装 skill、启动生产网页及项目信息 API，停止服务后正常退出。
- 已安装 bin 在本项目上实际检索“看板”且筛选 todo，返回 OT-003 与 OT-012 的原文与行号，diagnostics 为空。

最终包约 104 KiB，包含已有网页外壳。原生产 CLI 与静态服务回归通过；界面未改动，不重复执行上一轮 UI 测试。

## 当前限制

仅第一处单行字面短语命中；不是模糊或语义搜索。精选元数据中的 alias、非标量或过长值会诊断跳过。当前没有同义词配置、自动分类、批量 frontmatter 更新、PDF/Office/OCR、Agent 目录自动发现或卸载功能。

安装 skill 后仍需可用的 olav-tasks CLI，技能目录自身不复制 Node 运行库。npm 包尚未公开发布，完整第一版看板/文件管理与其他两个 skills 尚未完成。
