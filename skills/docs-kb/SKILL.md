---
name: docs-kb
description: Search local project Markdown and locate relevant passages by original path and line number before answering, writing, or organizing project documents.
---

# Local Markdown retrieval

Use the installed `olav-tasks` CLI to retrieve evidence from an explicitly chosen project directory. If the CLI is unavailable, explain the prerequisite; do not install packages or fetch remote documents automatically.

```bash
olav-tasks docs search /absolute/project/path "search phrase" --json
olav-tasks docs search /absolute/project/path "acceptance" --status in-progress --max-chars 3000 --json
olav-tasks docs search /absolute/project/path "deployment" --category engineering --doc-type guide --json
```

The query is a case-insensitive literal phrase on one original line. Multiple unquoted query arguments are joined with a single space; quote the phrase to preserve its spacing. Metadata filters compare exact text values. `--doc-type` filters `doc_type`; status filtering reads the existing field without changing task or document lifecycle conventions.

Search recursively reads `.md` files, including long documents, without splitting or modifying source files. It excludes `.git`, `node_modules`, `dist`, `build`, `.cache` and symlinks. Files above 8 MiB and invalid frontmatter are reported in diagnostics. Results contain the first matching context per file, at most 5 by default (`--limit` 1–100). Each excerpt is capped at 600 characters, retaining the actual match and up to one surrounding line on each side when space allows. Long matching lines are clipped with an ellipsis. Selected metadata display values are shortened; dependency arrays are omitted. Both human and compact JSON output are capped at 6000 characters total, including metadata, diagnostics and the final newline. `--max-chars` accepts 1000–20000. Characters approximate model input size; they are not a fixed token count.

Read retrieved snippets first. When they are insufficient, use `root` plus the relative `path` to read only the indicated original `startLine`–`endLine` range, with a small surrounding range if necessary. Do not reflexively load an entire large document. Cite the original file and one-indexed `matchLine` or `startLine`–`endLine`; verify enough of the passage to support the conclusion. Search snippets and diagnostics are retrieval aids, while the source Markdown remains authoritative.

When `truncated` is true, narrow the query or filters before increasing the output budget. Results and diagnostics may be omitted to stay within the budget; paths and JSON are never cut mid-value. Review `diagnostics` before claiming the search covered every document. An empty result with `truncated: true` is inconclusive: matching excerpts or diagnostics may have been omitted to fit the budget. Narrow the query or filters, or explicitly adjust the budget before claiming absence. Empty results without truncation mean the phrase was not found among eligible files; try terminology present in the project rather than inventing evidence.

This skill retrieves Markdown only. Writing, directory reorganization, classification updates, PDF/Office conversion and OCR require separate user-directed work; invoking retrieval does not authorize those changes.
