---
name: pr-review
description: Review someone else's PR against the spec of its issues. First reads the whole network of related issues, PRs and comments to build one consolidated spec, then reviews the PR code in two independent passes, verifies every finding, classifies which points truly deserve a comment, suggests English inline comments (never posts them), and, if the PR is clean, checks the PR description, CI and tests to conclude whether it is ready to approve. Use when the user says "review PR #N", "can this PR be approved", "draft comments for this PR", "review again after the author's fixes", or asks you to judge someone else's comment on a PR/issue ("what does this comment want confirmed, is it necessary"). Do not use for local lint/tests before opening a PR, for reviewing your own uncommitted changes, or for reviewing a spec document.
---

# PR Review: spec first, code second, fewest possible comments

This skill reviews a colleague's PR from the **reviewer's** side. It reads the whole network of issues to build the spec first,
and it keeps a high bar for leaving comments.

Invoking this skill means the user accepts running `Workflow` (roughly 15–30 agents, a noticeable token cost). For a quicker run pass
`fast: true` (one verifier per finding instead of two).

`<SKILL_DIR>` below is the base directory announced when this skill loads ("Base directory for this skill: …").
Scripts, references and the workflow live under it. The four `pr-*` agents ship in the same plugin.

## Invariant rules (the reason is in brackets)

1. **Never write to GitHub.** No `gh pr review|comment`, `gh issue comment`, `gh api -X POST|PATCH|PUT|DELETE`. Only suggest comments; the
   human reviewer decides what to post. (An explicit requirement of the user. To enforce it technically, add `deny` rules for these
   commands in `settings.json`; see the README.)
2. **Spec first, code second.** Do not review code without a consolidated spec. No issue found → stop and ask; do not guess.
   (A review without a spec is just personal opinion.)
3. **State only what was verified by code at the head SHA** and traced to real behaviour. (A "risk" was once flagged from code that never runs.)
4. **High comment threshold:** comment only when the author has to do something. FYI/nit/hand-off notes go in chat.
   (See `references/commentability-gate.md`.)
5. **Report honestly.** Say so when a phase is missing (`degraded`, `triageFailed`, `NEEDS_HUMAN`, unreadable sources); never conclude
   "ready to approve" while a check could not be done.
6. **Spec precedence:** the issue body is the root; a decision comment from the spec owner replaces only that point; the PR author's
   comments are questions. (See `references/spec-precedence.md`.)

## Project configuration (optional)

The skill reads `.claude/pr-review.config.json` from the repository being reviewed. Everything in it is optional; without it
the generic behaviour applies and the test-evidence checks are skipped. Fields:

| Field | Purpose |
|---|---|
| `projectContext` | One or two sentences about the product and stack, given to every agent |
| `conventionDocs` | Files/globs with project conventions the reviewers should consult |
| `scopeMarkers` | Extra phrases (any language) that mark out-of-scope sections in issues |
| `commentLanguage` | Language for suggested comments (default English) |
| `reportLanguage` | Language of the report to the user (default: the language the user wrote in) |
| `workspaceRoot` | Where the collector writes (default `.claude/planning/pr-review`; add it to `.gitignore`) |
| `refDigits`, `maxFullSources`, `maxTimelinePrs`, `fullDepth` | Reference-following limits of the collector |
| `ci.pathGroups`, `ci.tests`, `ci.notes` | What counts as backend/frontend, which CI job runs which tests, what a green job does not prove |
| `pullRequest.*` | Placeholder text to detect, migration paths and keywords |

A complete example is in `examples/pr-review.config.example.json` of the plugin repository.

## Two modes

- **A. Review a PR** (default): the full process below.
- **B. Evaluate someone else's comment:** when the user hands you a comment/URL and asks what it wants confirmed, whether it is necessary,
  or whether anything is off. See "Mode B".

## Mode A: steps

### Step 0: Identify the PR and any earlier state

- Take the PR number from the request (a number, a URL, or `gh pr view` for the current branch). Unclear → ask.
- If `<workspaceRoot>/PR-<N>/result.json` exists, compare the saved `headSha` with `gh pr view <N> --json headRefOid -q .headRefOid`.
  Different (the author pushed) or the user says "re-run / after the fix" → collect and run again from scratch (issues and comments may have changed).
  Same → show the old `result.md` and ask whether to re-run. A run interrupted midway → use `resumeFromRunId`.

### Step 1: Collect the context (deterministic, no AI)

```bash
python3 -I <SKILL_DIR>/scripts/collect_pr_context.py --pr <N> [--extra "<local spreadsheet/image>" ...]
```

The script follows references on its own: closing refs, `#N` in the title/body/comments/branch name, then timeline cross-references
(distance ≤ 1 is read in full, deeper items are only summarised under `dropped`), including the comments, reviews and review comments of
related PRs. It also `git fetch`es the PR head (working tree untouched) so agents can read code with `git show <headSha>:path`.
Spreadsheets passed with `--extra` are dumped to text and images (`dump_xlsx.py`).

Read `index.json` and check:
- `sources` empty → stop and ask which issue is the spec (rule 2).
- `gitObjectsFetched` false → report the error; agents that cannot read code at head cannot review.
- `dropped` contains an issue that looks important (same functional area) → mention it in the report so the user can decide whether to widen the limits.
- The user mentioned a local spec file (spreadsheet…) but you did not pass `--extra` → re-run with `--extra`.

### Step 2: Run the workflow

Call `Workflow` with `scriptPath: "<SKILL_DIR>/scripts/pr-review.workflow.js"` and `args` built from `index.json`:

```json
{ "mode": "pr", "fast": false, "skillDir": "<SKILL_DIR>", "agentNamespace": "pr-review-harness",
  "config": "<index.config>", "workspace": "<index.workspace>", "repo": "<index.repo>",
  "target": "<index.target>", "sources": "<index.sources>", "dropped": "<index.dropped>", "extra": "<index.extra>" }
```

Six phases: **Spec** (one agent per source) → **Synthesize** (merge the spec) → **Review** (two independent passes, topdown/bottomup, with a
coverage cross-check) → **Verify** (try to refute each finding; ≥ MEDIUM gets two lenses) → **Triage** (comment threshold, merge duplicates,
fill coverage gaps) → **Draft** (suggested English comments). Agent roles: `agents/pr-*.md`.
The script has hard gates: only a `confirmed` finding can become MUST/SHOULD; a finding that triage skips is re-classified or marked
`NEEDS_HUMAN`, never dropped.

### Step 3: Handle the result

1. Write the returned result to `<workspace>/result.json`.
2. Check the flags: `degraded` (a review pass is missing → the two-pass requirement is not met, offer a re-run), `triageFailed`,
   `unclassified`/`NEEDS_HUMAN` (read them yourself and judge; do not ignore), `uncoveredReqs`.
3. Validate the inline positions of drafts that have a `path`:
   ```bash
   python3 -I <SKILL_DIR>/scripts/validate_inline_lines.py <workspace>/diff.patch <json file [{path,line,side}]>
   ```
   A line outside the hunks → use `nearest` after re-reading the code to be sure it is the right anchor. A PR-level point (description) →
   `path: null`, suggested as a general PR comment.

### Step 4: Report (write it also to `<workspace>/result.md`)

Write the report in the user's language (or `reportLanguage`); the suggested comments stay in `commentLanguage` (English by default).

1. **Consolidated spec:** a few lines; main requirements, conflicts, unsettled items, pending decisions, unreadable sources.
2. **Two review passes:** findings per pass, how many confirmed/refuted/disputed; requirements the two passes rated differently.
3. **Classification:** MUST_COMMENT → SHOULD_COMMENT → CHAT_ONLY (one line each with the reason; DROP only as a count with the main reasons).
4. **Suggested comments** (MUST/SHOULD only): each in a code block with its `path:line`. State clearly **"not posted; you decide"**.
5. **Conclusion:** any MUST/SHOULD/NEEDS_HUMAN → "not ready to approve" + what to fix. None left → Step 5.

If the user wants comments removed or added, respect that. Never post on their behalf.

### Step 5: Approval conditions (only when no MUST/SHOULD/NEEDS_HUMAN remains)

```bash
python3 -I <SKILL_DIR>/scripts/pr_readiness.py <N>
```

Apply `references/approval-checklist.md` (A1–A8: not a draft/no conflicts, no unresolved thread or pending decision, complete and accurate
description, no unfinished uploads, clean CI, tests per configured suite, evidence for what CI does not enforce).
The result has two forms only: **"READY TO APPROVE"** (list each condition) or **"NOT READY"** (list the concrete fixes and who owns them).
A check that could not be run → write "not verified"; do not count it as met.

## Mode B: evaluate a comment

Follow `references/comment-evaluation.md`. In short: take the comment **verbatim** and re-read it before criticising anything; build the spec with the
workflow in `spec-only` mode (`mode: "spec-only"`; use `--issue <N>` when collecting for an issue, `--pr <N>` for a PR); check every fact the comment
asserts against code; for each point you want to raise ask "did the comment already say it? what must the recipient do? is it verified?".
If nothing survives the filter, say plainly "the comment is fine". Keep the report short; if a message is worth sending, draft it for the user to decide.

## Error handling

| Situation | What to do |
|---|---|
| `gh` not logged in or missing permission | Stop, tell the user to run `gh auth login`; do not continue with partial data. |
| The collector finds no issue | Ask the user which issue; do not review. |
| A custom agent cannot be loaded (plugin just installed, session not restarted) | The workflow tries the namespaced name, the bare name, then the generic agent told to read `agents/<name>.md`, and logs each step. If you see this a lot, restart the session. |
| An agent returns `null` | The workflow retries once; if it still fails, `degraded` or a missing source is recorded and reported. |
| A review pass is missing | The result is marked `degraded`; no approve conclusion; offer a re-run. |
| Usage limit / expired auth | Do not retry pointlessly; look at the partial output you have, record what is missing, tell the user (with the reset time for a usage limit). |
| Very large PR (many files) | It runs, but say which files were not read closely if agents report gaps; do not enable `fast`. |

## Working with what the repository already has

- Project conventions are reused, not copied: list them in `conventionDocs`.
- The agents have read-only tools (no Edit/Write). Rule 1 is otherwise a prompt-level rule, because agents still have Bash.
- The workspace (`workspaceRoot`) should be in `.gitignore`.

## Test scenarios

**Normal (the PR has points to comment on).** "Review PR #123": the collector finds the main issue, its related issues/PRs and any `--extra` spreadsheet →
the workflow runs six phases → the report has the consolidated spec, findings per pass, the MUST/SHOULD list with English comments that passed
`validate_inline_lines.py`, and the line "not posted". Check: no GitHub write command was run; every MUST/SHOULD has `verdict = confirmed`.

**Normal (a clean PR).** No MUST/SHOULD left → run `pr_readiness.py` → one of the two conclusions in Step 5. For a PR with an unanswered confirmation question
or an unfinished `Uploading …` attachment, the result must be "NOT READY" with exactly those two fixes.

**Errors.** (a) The PR links no issue → stop and ask. (b) Agent `pr-code-reviewer` unavailable → logged fallback, not a silent finish.
(c) A review pass returns `null` twice → `degraded: true`, the report says so, and there is no approve conclusion.

**Mode B.** "What does Alice's comment on PR #123 want confirmed, is it needed?": the report quotes the verbatim text, checks the facts in code, and if every
point was already raised by the comment itself concludes "fine, nothing more to send".

## When to use / not to use

Use: "review PR 123", "can this PR be approved", "draft comments for PR #130", "the author fixed it, review again", "is this comment from … necessary".
Do not use: "run lint/tests before I open a PR", "review the code I just wrote before committing", "review the spec document in docs/", "implement issue #N".
