#!/usr/bin/env python3
"""Return bounded, read-only document hits from a configured docs-kb checkout."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True, help="narrow document corpus root")
    parser.add_argument("--query", required=True, help="literal search text")
    parser.add_argument("--docs-kb-home", type=Path,
                        default=Path(os.environ["DOCS_KB_HOME"]) if os.environ.get("DOCS_KB_HOME") else None)
    parser.add_argument("--max-chars", type=int, default=8000)
    args = parser.parse_args()
    if args.docs_kb_home is None:
        parser.error("set DOCS_KB_HOME or pass --docs-kb-home")
    root = args.root.resolve(strict=True)
    home = args.docs_kb_home.resolve(strict=True)
    script = home / "scripts" / "search_docs.py"
    if not root.is_dir() or not script.is_file() or not args.query.strip():
        parser.error("document root, docs-kb search script, and query are required")
    if not 500 <= args.max_chars <= 16000:
        parser.error("max-chars must be between 500 and 16000")
    env = {"DOCS_KB_ROOT": str(root), "PATH": os.environ.get("PATH", ""),
           "LANG": os.environ.get("LANG", "C.UTF-8")}
    completed = subprocess.run(
        [sys.executable, str(script), re.escape(args.query), "--no-expand", "--no-log",
         "--max-matches", "2"], cwd=home, env=env, text=True,
        capture_output=True, timeout=20, check=False)
    if completed.returncode:
        print("docs_kb_search_failed", file=sys.stderr)
        return 2
    output = completed.stdout
    if len(output) > args.max_chars:
        output = output[:args.max_chars].rsplit("\n", 1)[0] + "\n[truncated; narrow the query]\n"
    print(output, end="" if output.endswith("\n") else "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
