# Conditions for a PR to be approvable

Run only when **no MUST_COMMENT / SHOULD_COMMENT / NEEDS_HUMAN remains** after Triage. Facts come from
`scripts/pr_readiness.py <PR>`; the reviewer applies the table below.
The final result has exactly two forms: **"READY TO APPROVE"** or **"NOT READY"** with a list of concrete fixes.

## Conditions (all must hold)

| # | Condition | How to check |
|---|---|---|
| A1 | No MUST/SHOULD/NEEDS_HUMAN left from the review | Triage result |
| A2 | The PR is not a draft and has no conflicts (`mergeable != CONFLICTING`) | `pr.isDraft`, `pr.mergeable` |
| A3 | No unresolved review thread; no **pending decision** from the spec owner (for example a confirmation question the author asked that nobody answered) | `unresolvedReviewThreads`, `recentComments`, spec `pending_decisions` |
| A4 | The description is complete: linked issue; the "what changed" section matches the real diff (no leftover template text); the testing section lists the tests that were run; migrations are declared when present; UI evidence when the UI changed | `description.*` compared with the diff |
| A5 | No unfinished attachment upload (`Uploading ….mov…`) | `description.unfinishedUploads` is empty |
| A6 | CI: no check is `fail/cancel/pending`; `skipping` is acceptable only when it makes sense | `ci.*` |
| A7 | **Tests, per configured suite** (`tests[]`): if the suite's group changed → either the CI job that runs it is green (`ciRunsTests: true`) **or** the description contains evidence of a local run (`evidenceInDescription`). Also check that the diff adds tests for the new logic | `tests[]`, review result on tests |
| A8 | **Anything CI does not enforce** (listed in `ciNotes`, for example "lint job ends with `|| true`") needs evidence in the description | `ciNotes`, `description.*` |

If the project has no config, A7 and A8 reduce to: CI is green, and the description says what was tested.
State that explicitly rather than assuming the tests ran.

## CI facts belong in the config

What a green CI job actually proves differs per repository (a job can be green because the test step is commented out).
Record those facts once in `ci.notes` of `.claude/pr-review.config.json`; `pr_readiness.py` prints them as `ciNotes`.
`skipping` jobs are normal when a change-detection job found nothing relevant — check that before flagging them.

## How to report

- **READY**: list every condition A1–A8 with its result (met / not applicable + reason). Include the remaining CHAT_ONLY
  items so the reviewer is aware of them.
- **NOT READY**: list each unmet condition with the **concrete action** and who owns it (PR author or spec owner).
  Never write something vague like "more tests needed".
- When a check cannot be run (no permission, command failed) → write "not verified" with the reason; do not count it as met.
