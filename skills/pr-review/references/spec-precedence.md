# Rules for building one spec from a network of issues

Used in the Spec and Synthesize phases. Goal: one spec in which every requirement is traceable to a source
and every undecided point is marked as such. Never invent a requirement to fill a gap.

## 1. Source precedence (highest first)

1. **Body of the main issue**, including dated addenda ("Update 2026-01-05", "Implementation plan").
   This is the root spec. When the body explicitly declares an outside document authoritative
   (for example "the spreadsheet is the source of truth"), that document is authoritative **within the scope it covers**.
2. **Decision comments from the spec owner** (issue author, maintainer, or whoever the body names as the confirmer):
   record the decision, who made it and when. It replaces the earlier text **only on that exact point**.
3. **Related issues**: their constraints apply when they touch the same area (for example "do not modify the existing
   template"). A CLOSED issue is a settled decision, including its out-of-scope items and anything it split into other issues.
4. **Related PRs**: a merged PR shows the real behaviour; an open PR in the same area is a conflict risk
   (point it out, do not judge it).
5. **Outside documents** (sheets, spreadsheets, wiki pages) that the body does *not* declare authoritative: reference only.
   They never override the body. On conflict, state the conflict and follow the body.

## 2. What is NOT spec

- Comments from the **PR author** (the developer): proposals or questions until the spec owner answers.
  An unanswered question goes to `pending_decisions`; it is not a decision.
- Your own inference of what "they probably want". If inference is unavoidable, mark it `inferred` and explain.
- Greetings, acknowledgements, scheduling chatter.

## 3. Scope

- Sections that mark scope boundaries — "Out of scope", "Non-goals", "Follow-up issue", "Not handled in this PR", plus any
  `scopeMarkers` from the project config (in any language) — in the main issue and in related issues are **boundaries**.
  A PR that does this work anyway is scope creep; a PR that skips it is correct and must not be reported as missing it.
- Mock/skeleton stage (when the issue or PR says so) → judge structure only, not the correctness of detailed logic.

## 4. Resolving conflicts

Record four things: the two sources, what each says, which one wins under section 1, and why.
If section 1 cannot settle it → put it in `unresolved`, and reviewers must **not** use that point against the PR.

## 5. Unreadable attachments

Images, videos and files hosted on GitHub (`user-attachments`) cannot be downloaded by the scripts. List them in
`unreadable_assets` so the reviewer knows part of the spec is missing. Local files passed with `--extra` are already dumped
to text and images: read `cells.txt`, and **open every image listed in `images.txt` with Read** — screenshots of the current
behaviour often contain information the text cells do not.

## 6. Shape of a requirement

`{id: "R1", text, source: "#123 §9", authority: "body|owner-comment|related-issue|reference", status: "explicit|inferred"}`.
Each requirement must be checkable by reading code or running a test; a vague requirement goes to `unresolved`.
