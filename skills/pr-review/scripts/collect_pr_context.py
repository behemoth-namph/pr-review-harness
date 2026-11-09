#!/usr/bin/env python3
"""Collect everything pr-review needs into a workspace directory (read-only; never writes to GitHub).

Usage:
  python3 -I collect_pr_context.py --pr 123 [--extra path1 path2 ...] [--config .claude/pr-review.config.json]
  python3 -I collect_pr_context.py --issue 120

Output: <workspaceRoot>/PR-<n>/ (or ISSUE-<n>/); the default root is .claude/planning/pr-review
  index.json            source list + metadata + the loaded config (read this first)
  pr.json               the target PR: description, comments, reviews, review comments
  diff.patch            the PR diff
  changed_files.txt     changed file paths
  sources/issue-N.json  an issue (body + every comment + references)
  sources/pr-N.json     a related PR (body + comments + review comments)
  extra/                local reference documents (xlsx dumped to text + images)

Standard library only. Needs an authenticated `gh` and must run inside the repository.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys

DEFAULT_CONFIG_PATH = ".claude/pr-review.config.json"
DEFAULTS = {
    "workspaceRoot": ".claude/planning/pr-review",
    "refDigits": [1, 7],       # issue/PR numbers matched as "#N": min and max digit count
    "fullDepth": 1,            # items up to this link distance from the target are read in full
    "maxFullSources": 14,      # cap on fully-read sources (the target PR is not counted)
    "maxTimelinePrs": 6,       # cap on cross-referenced PRs followed per depth-0 issue
}
ATTACH_RE = re.compile(r"https://github\.com/user-attachments/[^\s)\"'>]+|https://[^\s)\"'>]*\.(?:png|jpg|jpeg|gif|mov|mp4|xlsx|xls|pdf)\b")
URL_REF_RE = re.compile(r"/(?:issues|pull)/(\d{1,7})\b")
REF_RE = None  # compiled in main() once the config is known


def load_config(path):
    if not os.path.exists(path):
        return dict(DEFAULTS), False, {}
    try:
        with open(path, encoding="utf8") as f:
            user = json.load(f)
    except json.JSONDecodeError as e:
        sys.exit(f"Invalid JSON in {path}: {e}")
    return {**DEFAULTS, **{k: v for k, v in user.items() if k in DEFAULTS}}, True, user


def run(cmd, check=True):
    p = subprocess.run(cmd, capture_output=True, text=True)
    if check and p.returncode != 0:
        raise RuntimeError(f"{' '.join(cmd)}\n{p.stderr.strip()}")
    return p.stdout


def gh_json(args):
    return json.loads(run(["gh", *args]) or "null")


def gh_api_pages(path):
    """gh api --paginate --slurp -> flat list."""
    pages = gh_json(["api", "--paginate", "--slurp", path]) or []
    out = []
    for pg in pages:
        out.extend(pg if isinstance(pg, list) else [pg])
    return out


def refs_in(*texts):
    found = set()
    for t in texts:
        if not t:
            continue
        found.update(int(m) for m in REF_RE.findall(t))
        found.update(int(m) for m in URL_REF_RE.findall(t))
    return found


def attachments_in(*texts):
    found = []
    for t in texts:
        if t:
            found.extend(ATTACH_RE.findall(t))
    return sorted(set(found))


def slim_comment(c):
    return {
        "author": (c.get("user") or c.get("author") or {}).get("login"),
        "createdAt": c.get("created_at") or c.get("createdAt"),
        "body": c.get("body") or "",
    }


def fetch_item(repo, n):
    """Issues and PRs both go through the issues API; PRs get extra PR fields."""
    base = gh_json(["api", f"repos/{repo}/issues/{n}"])
    is_pr = "pull_request" in base
    item = {
        "number": n,
        "kind": "pr" if is_pr else "issue",
        "title": base.get("title"),
        "state": base.get("state"),
        "stateReason": base.get("state_reason"),
        "author": (base.get("user") or {}).get("login"),
        "createdAt": base.get("created_at"),
        "closedAt": base.get("closed_at"),
        "labels": [l["name"] for l in base.get("labels", [])],
        "url": base.get("html_url"),
        "body": base.get("body") or "",
        "comments": [slim_comment(c) for c in gh_api_pages(f"repos/{repo}/issues/{n}/comments")],
    }
    if is_pr:
        pr = gh_json(["api", f"repos/{repo}/pulls/{n}"])
        item["merged"] = bool(pr.get("merged"))
        item["baseRef"] = pr["base"]["ref"]
        item["headRef"] = pr["head"]["ref"]
        item["headSha"] = pr["head"]["sha"]
        item["reviews"] = [
            {"author": (r.get("user") or {}).get("login"), "state": r.get("state"),
             "submittedAt": r.get("submitted_at"), "body": r.get("body") or ""}
            for r in gh_api_pages(f"repos/{repo}/pulls/{n}/reviews") if (r.get("body") or "").strip()
        ]
        item["reviewComments"] = [
            {**slim_comment(c), "path": c.get("path"), "line": c.get("line") or c.get("original_line"),
             "inReplyTo": c.get("in_reply_to_id")}
            for c in gh_api_pages(f"repos/{repo}/pulls/{n}/comments")
        ]
    texts = [item["body"]] + [c["body"] for c in item["comments"]]
    if is_pr:
        texts += [r["body"] for r in item["reviews"]] + [c["body"] for c in item["reviewComments"]]
    item["refs"] = sorted(refs_in(*texts) - {n})
    item["attachments"] = attachments_in(*texts)
    return item


def timeline_refs(repo, n):
    """Other issues/PRs that mention n (cross-referenced). Returns [(number, is_pr)]."""
    try:
        events = gh_api_pages(f"repos/{repo}/issues/{n}/timeline")
    except RuntimeError:
        return []
    out = []
    for e in events:
        if e.get("event") != "cross-referenced":
            continue
        src = (e.get("source") or {}).get("issue") or {}
        if src.get("number"):
            out.append((src["number"], "pull_request" in src))
    return out


def dump_xlsx(path, outdir):
    helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dump_xlsx.py")
    run([sys.executable, "-I", helper, path, outdir])


def main():
    global REF_RE
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pr", type=int)
    g.add_argument("--issue", type=int)
    ap.add_argument("--extra", nargs="*", default=[], help="local reference documents (xlsx/md/txt/png)")
    ap.add_argument("--config", default=DEFAULT_CONFIG_PATH)
    ap.add_argument("--workspace-root", default=None, help="overrides workspaceRoot from the config")
    a = ap.parse_args()

    cfg, cfg_loaded, user_cfg = load_config(a.config)
    lo, hi = cfg["refDigits"]
    REF_RE = re.compile(r"(?<![\w/])#(\d{%d,%d})\b" % (lo, hi))
    branch_re = re.compile(r"(?:^|[/_-])(\d{%d,%d})(?=[_-]|$)" % (max(lo, 2), hi))
    full_depth, max_full, max_tl = cfg["fullDepth"], cfg["maxFullSources"], cfg["maxTimelinePrs"]

    repo = run(["gh", "repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]).strip()
    target_n = a.pr or a.issue
    root = a.workspace_root or cfg["workspaceRoot"]
    ws = os.path.join(root, f"{'PR' if a.pr else 'ISSUE'}-{target_n}")
    if os.path.isdir(ws):
        shutil.rmtree(ws)
    os.makedirs(os.path.join(ws, "sources"))

    index = {"repo": repo, "workspace": ws, "configLoaded": cfg_loaded, "config": user_cfg,
             "target": None, "sources": [], "dropped": [], "extra": []}
    seeds = {}  # number -> (depth, via)

    if a.pr:
        pr = fetch_item(repo, a.pr)
        if pr["kind"] != "pr":
            sys.exit(f"#{a.pr} is not a PR")
        closing = gh_json(["pr", "view", str(a.pr), "--json", "closingIssuesReferences,files,mergeable,isDraft,changedFiles,additions,deletions"])
        pr["closingIssues"] = [c["number"] for c in closing.get("closingIssuesReferences", [])]
        pr["files"] = [f["path"] for f in closing.get("files", [])]
        pr["isDraft"] = closing.get("isDraft")
        pr["mergeable"] = closing.get("mergeable")
        pr["stats"] = {k: closing.get(k) for k in ("changedFiles", "additions", "deletions")}
        with open(os.path.join(ws, "pr.json"), "w", encoding="utf8") as f:
            json.dump(pr, f, ensure_ascii=False, indent=2)
        with open(os.path.join(ws, "diff.patch"), "w", encoding="utf8") as f:
            f.write(run(["gh", "pr", "diff", str(a.pr)]))
        with open(os.path.join(ws, "changed_files.txt"), "w", encoding="utf8") as f:
            f.write("\n".join(pr["files"]) + "\n")
        # Fetch head/base objects locally (the working tree is untouched) so agents can run `git show <sha>:path`.
        try:
            run(["git", "fetch", "-q", "origin", f"pull/{a.pr}/head"])
            run(["git", "fetch", "-q", "origin", pr["baseRef"]])
            fetched = True
        except RuntimeError as e:
            fetched = False
            index["gitFetchError"] = str(e)
        index["target"] = {
            "kind": "pr", "number": a.pr, "title": pr["title"], "author": pr["author"], "state": pr["state"],
            "isDraft": pr["isDraft"], "baseRef": pr["baseRef"], "headRef": pr["headRef"], "headSha": pr["headSha"],
            "gitObjectsFetched": fetched, "path": "pr.json", "diffPath": "diff.patch",
            "changedFilesPath": "changed_files.txt", "stats": pr["stats"], "attachments": pr["attachments"],
        }
        # seeds: closing refs > #N in title/body > numbers in the branch name > #N in PR comments
        for n in pr["closingIssues"]:
            seeds.setdefault(n, (0, "closing-ref"))
        for n in sorted(refs_in(pr["title"], pr["body"])):
            seeds.setdefault(n, (0, "pr-title/body"))
        for m in branch_re.findall(pr["headRef"]):
            seeds.setdefault(int(m), (0, "branch-name"))
        for n in pr["refs"]:
            seeds.setdefault(n, (0, "pr-comments"))
    else:
        seeds[a.issue] = (0, "target")
        index["target"] = {"kind": "issue", "number": a.issue}

    seeds.pop(a.pr or -1, None)

    # BFS over references (#N, URLs, cross-references)
    queue = sorted(seeds.items())
    visited = set()
    full_count = 0
    while queue:
        (n, (depth, via)), queue = queue[0], queue[1:]
        if n in visited:
            continue
        visited.add(n)
        try:
            if depth > full_depth or full_count >= max_full:
                base = gh_json(["api", f"repos/{repo}/issues/{n}"])  # summary only, skip the comments
                item = {"number": n, "kind": "pr" if "pull_request" in base else "issue",
                        "state": base.get("state"), "title": base.get("title")}
            else:
                item = fetch_item(repo, n)
        except RuntimeError as e:
            index["dropped"].append({"number": n, "reason": f"fetch failed: {str(e)[:120]}"})
            continue
        item["depth"], item["via"] = depth, via
        if depth <= full_depth and full_count < max_full:
            full_count += 1
            fname = f"{item['kind']}-{n}.json"
            with open(os.path.join(ws, "sources", fname), "w", encoding="utf8") as f:
                json.dump(item, f, ensure_ascii=False, indent=2)
            index["sources"].append({
                "number": n, "kind": item["kind"], "depth": depth, "via": via, "state": item["state"],
                "title": item["title"], "path": f"sources/{fname}", "attachments": item["attachments"],
                "commentCount": len(item["comments"]),
            })
            nxt = depth + 1
            for r in item["refs"]:
                if r not in visited and r != a.pr:
                    queue.append((r, (nxt, f"ref-from-#{n}")))
            if depth == 0 and item["kind"] == "issue":
                added = 0
                for rn, is_pr in timeline_refs(repo, n):
                    if rn in visited or rn == a.pr or (is_pr and added >= max_tl):
                        continue
                    added += is_pr
                    queue.append((rn, (nxt, f"cross-ref-to-#{n}")))
        else:
            # too deep or over the cap: record a summary only, and say so (never drop silently)
            index["dropped"].append({
                "number": n, "kind": item["kind"], "state": item["state"], "title": item["title"],
                "depth": depth, "via": via,
                "reason": f"depth>{full_depth}" if depth > full_depth else f"over maxFullSources={max_full}",
            })
        queue.sort(key=lambda kv: kv[1][0])

    for p in a.extra:
        if not os.path.exists(p):
            index["extra"].append({"path": p, "error": "does not exist"})
            continue
        dest = os.path.join(ws, "extra", os.path.splitext(os.path.basename(p))[0])
        os.makedirs(dest, exist_ok=True)
        if p.lower().endswith((".xlsx", ".xlsm")):
            dump_xlsx(p, dest)
            index["extra"].append({"path": p, "dumpedTo": os.path.relpath(dest, ws), "kind": "xlsx"})
        else:
            shutil.copy(p, dest)
            index["extra"].append({"path": p, "dumpedTo": os.path.relpath(dest, ws), "kind": "file"})

    with open(os.path.join(ws, "index.json"), "w", encoding="utf8") as f:
        json.dump(index, f, ensure_ascii=False, indent=2)
    print(json.dumps({
        "workspace": ws,
        "configLoaded": cfg_loaded,
        "target": index["target"] and {k: index["target"][k] for k in ("kind", "number") if k in index["target"]},
        "sources": [(s["kind"], s["number"], s["state"], s["depth"]) for s in index["sources"]],
        "dropped": [(d["number"], d["reason"]) for d in index["dropped"]],
        "extra": index["extra"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
