# How to review the PR code (two independent passes)

Two reviewers run **independently**, never seeing each other's output, each taking a different route so that
the blind spots of the two passes do not coincide. Each reviewer re-checks their own work once more before returning.

## How to read the code

Work at the **PR head SHA**, not the working tree (the working tree is usually on another branch):

```bash
git show <headSha>:path/to/file                  # a file as it is in the PR
git grep -n "pattern" <headSha> -- 'src/**'      # callers / usages in the PR version
git show origin/<baseRef>:path/to/file           # the pre-PR version, for comparison
```

The diff is `diff.patch` in the workspace. Line numbers in findings are **right-side (head)** line numbers.

## Two routes

- **topdown (spec → code):** for each requirement in the spec, find the code that implements it at head and rate it
  `met/partial/unmet/unclear` with `file:line` evidence. Then scan the rest of the diff for changes that belong to no
  requirement (scope creep, regressions).
- **bottomup (diff → spec):** walk the hunks; for each change ask "what behaviour changes, and who else is affected?"
  (find callers with `git grep` at head and check the calling side: API/resolver/job/view/frontend). Then compare with the spec.

Both routes must return `coverage` for **every** requirement in the spec, so the two can be cross-checked.

## What to check (highest priority first)

1. **Spec conformance:** missing, wrong or misread requirements; doing something the issue excludes.
2. **Correctness:** nil/empty/boundary values, wrong conditions, transactions, job idempotency, regressions of old behaviour.
3. **Security and data isolation:** tenant/organisation scoping, authorisation, exposure of sensitive data
   (passwords, keys, tokens) in logs, mail or responses.
4. **Project conventions** (already written down in the repo — read the relevant ones, do not restate them): the files and
   globs listed under `conventionDocs` in the project config. Do not invent conventions that are not in those files.
5. **Tests:** is there a test for the new logic (happy path and failure)? Does the test really exercise the behaviour — would it
   fail if the change were reverted?
6. **PR description:** does it match the real diff; are required template sections missing; unfinished attachment uploads.

## Evidence discipline (lessons from mistakes already made)

- **Trace to the real runtime behaviour before concluding.** Code that looks risky is not yet a bug: find where and how it
  actually runs. Example: a template calls `html_safe`, but the mailer only declares a plain-text format, so the HTML view
  is never rendered — an "XSS" conclusion there would be wrong.
- **Compare with the real flow** before calling test/preview behaviour "wrong": it is often the same mechanism.
- **Read the PR description and the author's comments verbatim before reporting something as "missing".** Many points were
  already raised by the author; repeating them is noise.
- **Do not turn a decision the spec owner already confirmed into a defect.**
- Every finding needs a concrete `failure_scenario`: which input/state → which wrong result. If you cannot write one, it is not a finding.
- Unsure → set `confidence: low` or put it in `scope_notes` as "needs confirmation"; never phrase it as a fact.
- No praise, no generic remarks, no padding the count.

## Severity

`CRITICAL` (data exposure, data loss, core function broken, hard-spec violation) · `HIGH` (real bug, regression) ·
`MEDIUM` (minor spec deviation, missing test for risky logic, notable convention violation) · `LOW` (small improvement) ·
`NIT` (taste, style).
