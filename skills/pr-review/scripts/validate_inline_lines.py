#!/usr/bin/env python3
"""Check that inline comment positions fall inside the PR diff (GitHub rejects comments outside a hunk).

Usage: python3 -I validate_inline_lines.py <diff.patch> <comments.json>
  comments.json: [{"path": "src/app.rb", "line": 123, "side": "RIGHT"}]   (side defaults to RIGHT)
Prints JSON: each entry plus "ok", "reason" and, when invalid, "nearest" (closest valid line in the same file).
Exits 1 if any entry is invalid. Read-only; never calls GitHub.
"""
import json
import re
import sys

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def parse(diff_text):
    """Return {path: {"RIGHT": set(lines), "LEFT": set(lines)}} - the lines a review comment can attach to."""
    files, cur = {}, None
    left = right = 0
    for ln in diff_text.splitlines():
        if ln.startswith("diff --git "):
            cur = None
        elif ln.startswith("+++ "):
            p = ln[4:].strip()
            cur = None if p == "/dev/null" else (p[2:] if p.startswith("b/") else p)
            if cur:
                files.setdefault(cur, {"RIGHT": set(), "LEFT": set()})
        elif ln.startswith("--- "):
            continue
        else:
            m = HUNK_RE.match(ln)
            if m:
                left, right = int(m.group(1)), int(m.group(2))
            elif cur and ln[:1] in (" ", "+", "-"):
                if ln[0] == " ":
                    files[cur]["LEFT"].add(left)
                    files[cur]["RIGHT"].add(right)
                    left += 1
                    right += 1
                elif ln[0] == "+":
                    files[cur]["RIGHT"].add(right)
                    right += 1
                else:
                    files[cur]["LEFT"].add(left)
                    left += 1
    return files


def main(diff_path, comments_path):
    files = parse(open(diff_path, encoding="utf8").read())
    items = json.load(open(comments_path, encoding="utf8"))
    out, bad = [], 0
    for it in items:
        side = (it.get("side") or "RIGHT").upper()
        path, line = it.get("path"), it.get("line")
        valid = files.get(path, {}).get(side, set())
        if path not in files:
            res = {"ok": False, "reason": "file is not in the diff"}
        elif line in valid:
            res = {"ok": True, "reason": "ok"}
        else:
            near = min(valid, key=lambda x: abs(x - (line or 0))) if valid else None
            res = {"ok": False, "reason": "line is outside every diff hunk", "nearest": near}
        bad += not res["ok"]
        out.append({**it, **res})
    print(json.dumps(out, ensure_ascii=False, indent=2))
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
