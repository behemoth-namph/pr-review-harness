#!/usr/bin/env python3
"""Collect the facts needed to judge "is this PR ready to approve?" (read-only).

Usage: python3 -I pr_readiness.py <PR number> [--config .claude/pr-review.config.json]

Prints JSON: PR state, description analysis, CI check buckets, per-test-suite status,
unresolved review threads and recent comments. The script does NOT decide anything;
the verdict is made by the reviewer following references/approval-checklist.md.

Project-specific knowledge (which paths are "backend", which CI job runs which tests,
what test evidence looks like) comes from the optional config file. Without it, only
generic checks run. Only the standard library and an authenticated `gh` are needed.
"""
import argparse
import fnmatch
import json
import os
import re
import subprocess
import sys

DEFAULT_CONFIG_PATH = ".claude/pr-review.config.json"


def load_config(path):
    if not os.path.exists(path):
        return {}, False
    try:
        with open(path, encoding="utf8") as f:
            return json.load(f), True
    except json.JSONDecodeError as e:
        sys.exit(f"Invalid JSON in {path}: {e}")


def gh(args):
    p = subprocess.run(["gh", *args], capture_output=True, text=True)
    if p.returncode != 0:
        return None, p.stderr.strip()
    return p.stdout, None


def matches(path, patterns):
    """fnmatch globs; a trailing '/' means 'anything under this directory'."""
    for p in patterns:
        if p.endswith("/"):
            p += "*"
        if fnmatch.fnmatchcase(path, p):
            return True
    return False


def describe_body(body, pr, cfg):
    # A heading's content includes its sub-headings (up to the next heading of the same or higher level).
    marks = [(m.start(), m.end(), len(m.group(1)), m.group(2).strip())
             for m in re.finditer(r"^(#{1,3})\s+(.+?)\s*$", body, flags=re.M)]
    sections = {}
    for i, (_, end, level, title) in enumerate(marks):
        stop = next((s for (s, _, lv, _) in marks[i + 1:] if lv <= level), len(body))
        sections[title] = body[end:stop].strip()
    empty = [k for k, v in sections.items()
             if not re.sub(r"^#{1,6}\s+.*$|[-*\s]|\(.*?\)", "", v, flags=re.M)]
    pr_cfg = cfg.get("pullRequest", {})
    placeholders = [p for p in pr_cfg.get("placeholderPatterns", []) if re.search(p, body, flags=re.I)]
    return {
        "length": len(body),
        "headings": [t for (_, _, _, t) in marks],
        "emptySections": empty,
        "relatedIssueLinked": bool(re.search(r"(?<![\w/])#\d+\b", body)),
        "closingIssues": [c["number"] for c in pr.get("closingIssuesReferences", [])],
        # leftover template text the author forgot to replace (patterns come from the config)
        "placeholderTextFound": placeholders,
        # "Uploading xxx.mov…" is what GitHub leaves behind when an attachment upload never finished
        "unfinishedUploads": re.findall(r"Uploading [^\n]*?(?:…|\.\.\.)", body),
        "mentionsMigration": bool(re.search(pr_cfg.get("migrationKeywords", "migrat"), body, flags=re.I)),
    }


def main(n, cfg_path):
    cfg, cfg_loaded = load_config(cfg_path)
    ci_cfg = cfg.get("ci", {})

    out, err = gh(["pr", "view", str(n), "--json",
                   "number,title,body,state,isDraft,mergeable,mergeStateStatus,reviewDecision,baseRefName,"
                   "headRefName,labels,files,comments,closingIssuesReferences,author,url"])
    if out is None:
        sys.exit(err)
    pr = json.loads(out)
    body = pr.get("body") or ""
    files = [f["path"] for f in pr.get("files", [])]

    groups = {name: [f for f in files if matches(f, pats)] for name, pats in ci_cfg.get("pathGroups", {}).items()}
    migration_globs = cfg.get("pullRequest", {}).get("migrationPaths", ["*db/migrate/*"])
    changed = {
        "fileCount": len(files),
        "groups": {k: len(v) for k, v in groups.items()},
        "migrationFiles": [f for f in files if matches(f, migration_globs)],
    }

    out, err = gh(["pr", "checks", str(n), "--json", "name,state,bucket,workflow,link"])
    checks = json.loads(out) if out else []
    by = {}
    for c in checks:
        by.setdefault(c["bucket"], []).append(c["name"])
    ci = {
        "error": None if out else err,
        "total": len(checks),
        "pass": len(by.get("pass", [])),
        "fail": by.get("fail", []),
        "pending": by.get("pending", []),
        "cancel": by.get("cancel", []),
        "skipping": by.get("skipping", []),
    }

    # per test suite: does the group have changes, does a CI job run it, is there evidence in the description
    tests = []
    for t in ci_cfg.get("tests", []):
        group = t.get("group")
        job = t.get("ciJob")
        pat = t.get("evidencePattern")
        tests.append({
            "name": t.get("name"),
            "group": group,
            "groupChanged": bool(groups.get(group)),
            "ciRunsTests": bool(t.get("ciRunsTests")),
            "ciJob": job,
            "ciJobResult": next((c for c in checks if job and c["name"].startswith(job)), None),
            "evidenceInDescription": bool(re.search(pat, body, flags=re.I)) if pat else None,
        })

    # unresolved review threads (GraphQL, read-only)
    repo, _ = gh(["repo", "view", "--json", "owner,name", "-q", ".owner.login + \"/\" + .name"])
    owner, name = (repo or "/").strip().split("/")
    q = ("query($o:String!,$n:String!,$p:Int!){repository(owner:$o,name:$n){pullRequest(number:$p){"
         "reviewThreads(first:100){nodes{isResolved isOutdated path line comments(first:1){nodes{author{login} body}}}}}}}")
    out, err = gh(["api", "graphql", "-f", f"query={q}", "-F", f"o={owner}", "-F", f"n={name}", "-F", f"p={n}"])
    threads = []
    if out:
        nodes = json.loads(out)["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        threads = [{"path": t["path"], "line": t["line"], "outdated": t["isOutdated"],
                    "author": ((t["comments"]["nodes"] or [{}])[0].get("author") or {}).get("login"),
                    "body": ((t["comments"]["nodes"] or [{}])[0].get("body") or "")[:200]}
                   for t in nodes if not t["isResolved"]]

    result = {
        "configLoaded": cfg_loaded,
        "pr": {k: pr.get(k) for k in ("number", "title", "state", "isDraft", "mergeable", "mergeStateStatus",
                                       "reviewDecision", "baseRefName", "headRefName", "url")},
        "author": (pr.get("author") or {}).get("login"),
        "changed": changed,
        "description": describe_body(body, pr, cfg),
        "ci": ci,
        "tests": tests,
        "unresolvedReviewThreads": threads,
        "recentComments": [{"author": (c.get("author") or {}).get("login"), "createdAt": c["createdAt"], "body": c["body"][:400]}
                           for c in pr.get("comments", [])[-5:]],
        "ciNotes": ci_cfg.get("notes", []),
    }
    if not cfg_loaded:
        result["hint"] = (f"No {cfg_path} found: test-suite and path-group checks were skipped. "
                          "See examples/pr-review.config.example.json in the plugin repo.")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("pr", type=int)
    ap.add_argument("--config", default=DEFAULT_CONFIG_PATH)
    a = ap.parse_args()
    main(a.pr, a.config)
