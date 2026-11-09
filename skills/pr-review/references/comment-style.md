# Style of suggested inline comments (English)

These are **suggestions only**. The reviewer decides whether to post. Never run `gh pr review`, `gh pr comment`,
`gh issue comment`, `gh api` with POST/PATCH/PUT/DELETE, and never use any other tool that writes to GitHub.

## Format

- English, 1 to 3 sentences, at most about 60 words (unless the project config sets another `commentLanguage`).
- Sentence 1: what is wrong and its concrete consequence (input/state → wrong result).
- Sentence 2: the fix you want, or the decision the author must make. Use a ```suggestion block only when the fix fits inside that single line.
- Cite the spec when the point is a spec deviation: `(#123 §9)`.
- No greeting, no "I think maybe", no praise, no long explanation. Direct and polite.
- Severity prefix (optional but be consistent): `[must]` or `[should]`.

## Position

- `path` is repo-relative; `line` is the **right-side (head)** line number; `side: "RIGHT"`.
- The line must be inside a hunk of the diff. Run `scripts/validate_inline_lines.py`; if invalid, use `nearest`.
- A finding that spans several lines → anchor on the line that is clearly wrong. A PR-level finding (the description) →
  suggest a general PR comment and set `path: null`.

## Good example

```
[must] `signup_link_for` returns '' for suspended customers, but the test-mail builder still renders the signup block with
the dummy key, so the "one side only" rule (#123 §9) is not met for real sends. Please guard the real-send path the same way.
```

## Bad examples (do not write)

- "Looks good overall, but maybe consider renaming this." (praise + a nit that asks for no action)
- "This might be a problem in some cases." (no failure_scenario)
- "FYI this changes the report numbers; no change needed." (CHAT_ONLY — do not post)
