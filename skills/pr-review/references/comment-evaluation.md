# Evaluating someone else's comment (mode B)

Use when asked "what does this comment from X want confirmed, is it necessary, is anything wrong with it?".
The subject can be a developer's confirmation question on a PR, a reviewer's comment, or a spec-deciding comment.

## Steps

1. **Get the verbatim text**, not a summary: `gh api repos/<repo>/issues/<n>/comments` (or `pulls/<n>/comments`).
   Quote it in the report. Before criticising anything, **read the verbatim text one more time**.
2. **Build the spec** from the issue network (Spec + Synthesize phases, `spec-only` mode), including attached images/spreadsheets.
3. **Split the comment into propositions**: (a) facts it asserts, (b) questions it asks, (c) decisions it wants someone to make.
4. **Check each fact** against code at the head SHA (trace to real behaviour as in `review-lenses.md`). A wrong fact is the most
   worthwhile thing to raise.
5. **For each question**, ask: does the spec already answer it? (if so the asker could decide alone) · does it target a genuinely
   undecided point · would the answer change code or a decision · who has the authority to answer (spec owner or developer).
6. **List the points worth raising**, then run the threshold test on **each** point:
   - Has the comment already said this? (re-read the verbatim text; many "missing" points are actually there.)
   - Is there a **concrete action** for the recipient? If not → drop.
   - Is it only cosmetic (a broken section reference that is immediately explained in parentheses)? → drop or merge into one line.
   - Was it **verified in code**, or is it a guess? A guess → drop.
7. Be honest: if nothing survives step 6, say plainly "the comment is fine, nothing more to send".

## Report (short)

1. What the comment wants confirmed (1–3 lines).
2. Whether it is necessary, and why (which spec point or constraint makes it needed or redundant).
3. The points worth raising, each with an action for the recipient. If there are none, say so.
4. If there are points: a short ready-to-send message for the recipient (the user decides whether to send it).

## Mistakes that have happened (do not repeat)

- Concluding "question 1 asks about the wrong thing" when the verbatim text already asked exactly that (did not re-read it).
- Flagging "removing the escaping is a risk" without checking which format the mail is really sent in (plain text; the HTML view is unused).
- Listing six points when only one cosmetic point survived. The number of points is not a measure of quality.
