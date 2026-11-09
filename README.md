# pr-review-harness

A [Claude Code](https://claude.com/claude-code) plugin that reviews **someone else's pull request** the way a careful human reviewer would:
read the issues first, then the code, then say as little as possible.

It suggests comments. **It never posts them.** You decide what goes on the PR.

## What it does

```
collect (script, no AI)   follow #N / closing refs / timeline cross-references; fetch the PR head
        │
   Spec  ── one agent per issue/PR reads every comment closely
        │
   Synthesize ── one consolidated spec (precedence rules, conflicts, pending decisions, scope boundaries)
        │
   Review ── two independent passes (spec→code and diff→spec), each re-checks itself, coverage cross-checked
        │
   Verify ── a skeptic agent tries to refute each finding by tracing real behaviour at the head SHA
        │
   Triage ── comment threshold: "what must the author do?"  MUST / SHOULD / CHAT_ONLY / DROP
        │
   ┌────┴─────────────────────────────┐
 Draft: short English inline comments    Nothing to comment? → readiness check:
 (positions validated against the diff)   description, unresolved threads, CI, tests → READY / NOT READY + fixes
```

Design choices that matter:

- **Spec before code.** No issue found → it stops and asks instead of reviewing against its own opinions.
- **Two independent reviewers** on different routes, so their blind spots do not coincide; **a separate verifier** for each finding, because the finder should not grade itself.
- **Hard gates in code, not just prompts:** only a finding the verifier *confirmed* can become a comment suggestion; a finding triage forgets is re-classified or marked `NEEDS_HUMAN`, never dropped; a missing review pass sets `degraded` and blocks any "ready" verdict.
- **High comment threshold.** FYI notes and nits go in the chat report, not on the PR.
- **Mode B** evaluates a comment someone else wrote ("what does this want confirmed, is it necessary?") with the same evidence discipline.

## Install

Requirements: Claude Code with plugins and the `Workflow` tool, `gh` (authenticated, run inside the repository being reviewed), `git`, Python 3.8+ (standard library only), and an `origin` remote that allows `git fetch origin pull/N/head`.

```text
/plugin marketplace add behemoth-namph/pr-review-harness
/plugin install pr-review-harness@pr-review-harness
```

Alternatively copy `skills/pr-review` to `.claude/skills/` and `agents/*.md` to `.claude/agents/` of your project.
In that layout nothing else is needed: the workflow tries `pr-review-harness:<agent>` first and falls back to the bare agent name.

> The plugin metadata and install commands follow the Claude Code plugin format, but have not been exercised against a live
> marketplace install yet. If something does not load, please open an issue.

## Use

In the repository you want to review, ask Claude:

```text
review PR #123
can PR 123 be approved?
the author pushed fixes, review PR 123 again
what does Alice's comment on PR 123 want confirmed — is it needed?
```

Pass `fast: true` (say "quick review") to use one verifier per finding instead of two. A typical run is roughly 15–30 agent calls.

Add the workspace to your `.gitignore` (default `.claude/planning/pr-review/`).

## Configure for your project (optional)

Create `.claude/pr-review.config.json` in the repository being reviewed. Without it the generic behaviour applies and test-evidence checks are skipped.
See [`examples/pr-review.config.example.json`](examples/pr-review.config.example.json).

| Field | Purpose |
|---|---|
| `projectContext` | Product/stack summary given to every agent |
| `conventionDocs` | Convention files/globs the reviewers should consult |
| `scopeMarkers` | Extra phrases (any language) marking out-of-scope sections in issues |
| `commentLanguage` / `reportLanguage` | Language of suggested comments / of the report |
| `workspaceRoot` | Where collected data is written |
| `refDigits`, `maxFullSources`, `maxTimelinePrs`, `fullDepth` | How far the collector follows references |
| `ci.pathGroups` | Name → path globs (`backend`, `frontend`, …); a trailing `/` means "everything under" |
| `ci.tests[]` | Per suite: `group`, `ciJob` (name prefix), `ciRunsTests`, `evidencePattern` (regex for proof in the PR description) |
| `ci.notes` | What a green job does *not* prove (a disabled test step, `|| true`, …) |
| `pullRequest.*` | Template placeholder regexes, migration paths and keywords |

## Safety

- The workflow, scripts and agents only read from GitHub. The agents have no Edit/Write tools.
- "Never write to GitHub" is enforced in the agent prompts, **not** by the sandbox, because agents still have Bash. To make it a hard rule, add deny rules to your
  `.claude/settings.json`:

  ```json
  { "permissions": { "deny": ["Bash(gh pr review:*)", "Bash(gh pr comment:*)", "Bash(gh issue comment:*)", "Bash(gh api -X POST:*)", "Bash(gh api --method POST:*)"] } }
  ```
- Review data (issue text, comments) is untrusted input. Agents are told to treat it as data, but a malicious issue could still try to steer a review; read the report with that in mind.

## Layout

```
.claude-plugin/        plugin.json, marketplace.json
agents/                pr-spec-analyst, pr-code-reviewer, pr-finding-verifier, pr-comment-drafter
skills/pr-review/      SKILL.md (orchestrator), references/, scripts/
examples/              example project config
tests/                 offline tests (mock workflow run, diff-hunk parsing)
```

## Tests

```bash
node tests/mock_workflow.test.mjs          # runs the workflow with fake agents and asserts the hard gates
python3 -I tests/test_validate_inline_lines.py
```

The mock run checks the orchestration logic only. It does not say anything about the quality of real agents' reviews; that has been exercised
by hand on real PRs, not by an automated benchmark.

## License

MIT
