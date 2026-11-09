# Comment threshold: when to leave a comment for the PR author

The bar for posting a comment is higher than the bar for "found something true". Investigate deeply and report everything
in chat; suggest posting only when the author **must do something**. Comments of the "FYI — no change needed" kind cost the
author time and get deleted.

## The main test

> "What does this comment ask the author to do?"

If the answer is "nothing", or you would have to write "no code change needed" → `CHAT_ONLY`, do not suggest posting.

## Four mandatory questions per finding

| # | Question | If "no" |
|---|---|---|
| Q1 | Was it **verified by reading code at the head SHA** (not guessed), and did the verifier confirm it? | `DROP` (refuted) or `CHAT_ONLY` as "needs confirmation" (uncertain/disputed) |
| Q2 | Does the author have a **concrete action** (fix code, fix the PR description, decide the scope, add a test)? | `CHAT_ONLY` |
| Q3 | Is it **within the scope** of the issue, or a violation of the spec / a related issue's constraint? | `CHAT_ONLY` (if it belongs to later work) or `DROP` |
| Q4 | Has it **not already** been raised in the PR description, the author's comments, or an existing thread? | `DROP` (duplicate) |

## Classes

- **MUST_COMMENT**: deviates from a hard spec; a bug with a concrete `failure_scenario`; data or tenant-isolation leak; data loss;
  regression; direct conflict with a related issue's constraint. Should not merge until handled.
- **SHOULD_COMMENT**: real and needs author action but does not block merge: missing tests for new logic, violation of a documented
  project convention, wrong/missing required section in the PR description, small scope creep to split out.
  Each such comment still needs a concrete action.
- **CHAT_ONLY**: true but asks for no action: heads-up about a side effect, backfill suggestion, hand-off note for a later issue,
  a nit that does not change behaviour, an unconfirmed "needs confirmation" point, a decision pending from the spec owner.
  Still **reported in chat** so the reviewer knows.
- **DROP**: refuted, duplicate, personal taste, already covered by the spec / PR description / tests. One line of reason in the report.

## Merge and avoid noise

- One root cause → **one** comment (merge the related lines, anchor on the clearest one).
- One comment = one thing. No praise, no summary comments, no questions that the issues already answer.
- A **question to the author** only when the answer changes code or a decision and cannot be looked up in the issues.
- Several nits of the same kind → a single `CHAT_ONLY`.
- Reviewing a mock/skeleton stage → keep only structural findings.

## Ordering

Sort MUST (by severity) → SHOULD → CHAT_ONLY. If no MUST/SHOULD remains → move on to the approval conditions
(`approval-checklist.md`). CHAT_ONLY items do not block approval.
