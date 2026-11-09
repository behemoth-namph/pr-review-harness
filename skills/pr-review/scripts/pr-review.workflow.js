export const meta = {
  name: 'pr-review',
  description: 'Review a PR against a spec consolidated from its issue network: two independent review passes, adversarial verification of every finding, comment-threshold triage, and suggested English inline comments (never posted)',
  phases: [
    { title: 'Spec', detail: 'one agent reads each related issue/PR closely' },
    { title: 'Synthesize', detail: 'merge the notes into one spec' },
    { title: 'Review', detail: 'two independent code reviews (topdown, bottomup)' },
    { title: 'Verify', detail: 'try to refute each finding by tracing code at the head SHA' },
    { title: 'Triage', detail: 'apply the comment threshold, merge duplicates, fill coverage gaps' },
    { title: 'Draft', detail: 'suggest inline comments for the points that need one' },
  ],
}

// args (passed by the pr-review skill after running collect_pr_context.py):
//   { mode: 'pr' | 'spec-only', fast?: boolean, skillDir, agentNamespace?, config?, workspace, repo,
//     target: { number, title, author, state, baseRef, headRef, headSha, path, diffPath, changedFilesPath },
//     sources: [{ number, kind, depth, via, state, title, path }], dropped: [...], extra: [{ dumpedTo, kind }] }
// The result is plain data; the calling skill writes files, builds the report and runs the later steps
// (inline-position check, approval conditions). This workflow NEVER writes to GitHub.

const A = args
if (!A || !A.workspace || !A.target || !A.skillDir) throw new Error('args is missing workspace/target/skillDir (run collect_pr_context.py first)')

const MODE = A.mode || 'pr'
const WS = A.workspace
const REF = `${A.skillDir}/references`
const CFG = A.config || {}
const NS = A.agentNamespace || 'pr-review-harness'
const NO_WRITE = 'Never write to GitHub (gh ... comment|review|edit|close|merge, gh api -X POST|PATCH|PUT|DELETE) and never edit files.'

// Project knowledge comes from the target repo's config; everything is optional.
const CTX = [
  `PROJECT CONTEXT: ${CFG.projectContext || '(none given; infer the stack from the repository)'}`,
  `CONVENTIONS (read the relevant ones, do not restate them): ${(CFG.conventionDocs || []).join(', ') || '(none listed)'}`,
  `SCOPE MARKERS (section titles/phrases that mark out-of-scope work, besides the usual ones): ${(CFG.scopeMarkers || []).join(', ') || '(none)'}`,
].join('\n')
const COMMENT_LANG = CFG.commentLanguage || 'English'

// ---------- schemas ----------
const SEVERITY = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'NIT']
const CATEGORY = ['spec-mismatch', 'bug', 'security', 'regression', 'test', 'scope', 'convention', 'pr-description']

const NOTES_SCHEMA = {
  type: 'object',
  properties: {
    source: { type: 'string' },
    role: { type: 'string' },
    summary: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string' }, source: { type: 'string' },
          authority: { type: 'string', enum: ['body', 'owner-comment', 'related-issue', 'related-pr', 'reference'] },
          status: { type: 'string', enum: ['explicit', 'inferred'] },
        },
        required: ['text', 'source', 'authority', 'status'],
      },
    },
    decisions: {
      type: 'array',
      items: { type: 'object', properties: { text: { type: 'string' }, by: { type: 'string' }, date: { type: 'string' }, source: { type: 'string' }, supersedes: { type: 'string' } }, required: ['text', 'by', 'source'] },
    },
    boundaries: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    constraints_for_other_prs: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    pending_questions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, asked_by: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    conflicts: { type: 'array', items: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string' }, note: { type: 'string' } }, required: ['a', 'b', 'note'] } },
    unreadable_assets: { type: 'array', items: { type: 'string' } },
  },
  required: ['source', 'summary', 'requirements', 'decisions', 'boundaries', 'pending_questions'],
}

const SPEC_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    requirements: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, text: { type: 'string' }, source: { type: 'string' },
          authority: { type: 'string' }, status: { type: 'string', enum: ['explicit', 'inferred'] },
        },
        required: ['id', 'text', 'source', 'authority', 'status'],
      },
    },
    boundaries: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    constraints: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    conflicts: { type: 'array', items: { type: 'object', properties: { sources: { type: 'string' }, description: { type: 'string' }, winner: { type: 'string' }, reason: { type: 'string' } }, required: ['sources', 'description', 'reason'] } },
    unresolved: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, why: { type: 'string' } }, required: ['text', 'why'] } },
    pending_decisions: { type: 'array', items: { type: 'object', properties: { text: { type: 'string' }, asked_by: { type: 'string' }, source: { type: 'string' } }, required: ['text', 'source'] } },
    unreadable_assets: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'requirements', 'boundaries', 'constraints', 'conflicts', 'unresolved', 'pending_decisions'],
}

const FINDING_PROPS = {
  title: { type: 'string' },
  severity: { type: 'string', enum: SEVERITY },
  category: { type: 'string', enum: CATEGORY },
  file: { type: 'string' },
  line: { type: ['integer', 'null'] },
  claim: { type: 'string' },
  evidence: { type: 'string' },
  failure_scenario: { type: 'string' },
  spec_ref: { type: 'string' },
  confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
}
const FINDING_REQUIRED = ['title', 'severity', 'category', 'claim', 'evidence', 'failure_scenario']

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'object', properties: FINDING_PROPS, required: FINDING_REQUIRED } },
    coverage: {
      type: 'array',
      items: {
        type: 'object',
        properties: { req_id: { type: 'string' }, status: { type: 'string', enum: ['met', 'partial', 'unmet', 'unclear'] }, evidence: { type: 'string' } },
        required: ['req_id', 'status', 'evidence'],
      },
    },
    scope_notes: { type: 'string' },
  },
  required: ['findings', 'coverage', 'scope_notes'],
}

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    reason: { type: 'string' },
    evidence: { type: 'string' },
    corrected_line: { type: ['integer', 'null'] },
    corrected_severity: { type: 'string', enum: SEVERITY },
  },
  required: ['verdict', 'reason', 'evidence'],
}

const CLASSES = ['MUST_COMMENT', 'SHOULD_COMMENT', 'CHAT_ONLY', 'DROP']
const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    decisions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          finding_id: { type: 'string' },
          class: { type: 'string', enum: CLASSES },
          reason: { type: 'string' },
          author_action: { type: 'string' },
          merged_into: { type: 'string' },
        },
        required: ['finding_id', 'class', 'reason'],
      },
    },
    additional: {
      type: 'array',
      items: { type: 'object', properties: { ...FINDING_PROPS, class: { type: 'string', enum: CLASSES }, author_action: { type: 'string' } }, required: [...FINDING_REQUIRED, 'class'] },
    },
    coverage_notes: { type: 'string' },
  },
  required: ['decisions', 'additional', 'coverage_notes'],
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    path: { type: ['string', 'null'] },
    line: { type: ['integer', 'null'] },
    side: { type: 'string', enum: ['RIGHT', 'LEFT'] },
    severity_tag: { type: 'string', enum: ['[must]', '[should]'] },
    body: { type: 'string' },
    note: { type: 'string' },
  },
  required: ['path', 'line', 'side', 'severity_tag', 'body'],
}

// ---------- helpers ----------
// Resolve the custom agent. A plugin's agents are namespaced ("<plugin>:<agent>"); a copied-into-.claude/agents install uses the bare name.
// An exception means "that name is unknown" -> try the next candidate. A null result means the agent ran but produced nothing ->
// retry once with the generic agent, told to read the agent definition file. Every fallback is logged; nothing is dropped silently.
const resolved = {}
async function run(agentType, prompt, opts) {
  const candidates = resolved[agentType] ? [resolved[agentType]] : [`${NS}:${agentType}`, agentType]
  for (const type of candidates) {
    try {
      const r = await agent(prompt, { ...opts, agentType: type })
      resolved[agentType] = type
      if (r) return r
      break
    } catch (e) {
      log(`${opts.label}: agentType ${type} failed (${String(e).slice(0, 100)})`)
    }
  }
  log(`${opts.label}: retrying with the generic agent`)
  try {
    return await agent(`First read ${A.skillDir}/../../agents/${agentType}.md (or the agent definition named ${agentType} if that path does not exist) and act exactly in the role it defines.\n\n${prompt}`, opts)
  } catch (e) {
    log(`${opts.label}: failed (${String(e).slice(0, 100)})`)
    return null
  }
}

const j = (x) => JSON.stringify(x, null, 1)
const T = A.target
const prMeta = T.headSha
  ? `PR #${T.number} "${T.title}" (author ${T.author}, base ${T.baseRef}, head ${T.headRef}, headSha ${T.headSha})`
  : `#${T.number}`  // spec-only mode on an issue: there is no PR yet
const files = `Workspace: ${WS}\n- ${WS}/${T.path} (PR description, the author's comments and reviews)\n- ${WS}/${T.diffPath} (diff)\n- ${WS}/${T.changedFilesPath}`

function specPrompt(s) {
  const role = s.kind === 'pr-target'
    ? 'TARGET PR (its description and the author\'s comments are proposals/questions, not spec)'
    : s.depth === 0 ? 'MAIN issue' : `RELATED source (depth ${s.depth}, ${s.via})`
  const extra = (A.extra || []).map((e) => `- ${WS}/${e.dumpedTo} (${e.kind})`).join('\n')
  return `Analyse the source: ${s.kind === 'pr-target' ? 'PR' : s.kind} #${s.number} "${s.title}" (state ${s.state}), role: ${role}.
File: ${WS}/${s.path}
${extra ? `Local reference documents (use only if your source mentions them; images listed in images.txt must be opened with Read):\n${extra}\n` : ''}${CTX}
References directory (REF): ${REF}. Read ${REF}/spec-precedence.md first. Read the ENTIRE content and every comment. Return the schema; set "source" to "${s.kind === 'pr-target' ? 'PR' : s.kind} #${s.number}".
${NO_WRITE}`
}

// ---------- phase 1: Spec ----------
phase('Spec')
const specJobs = []
if (MODE === 'pr') specJobs.push({ kind: 'pr-target', number: T.number, title: T.title, state: T.state, depth: -1, path: T.path })
for (const s of A.sources || []) if (s.depth <= 1) specJobs.push(s)

const notesRaw = await pipeline(specJobs, (s) =>
  run('pr-spec-analyst', specPrompt(s), { phase: 'Spec', label: `spec:${s.kind}#${s.number}`, schema: NOTES_SCHEMA })
)
const notes = notesRaw.filter(Boolean)
const missingNotes = specJobs.filter((_, i) => !notesRaw[i]).map((s) => `${s.kind}#${s.number}`)
log(`Spec: read ${notes.length}/${specJobs.length} sources.` + (missingNotes.length ? ` MISSING: ${missingNotes.join(', ')}` : ''))
if ((A.dropped || []).length) log(`Not read in full (too deep / over the cap): ${(A.dropped || []).map((d) => '#' + d.number).join(', ')}`)

// ---------- phase 2: Synthesize ----------
phase('Synthesize')
const spec = await agent(
  `Merge the spec notes below into ONE spec for ${prMeta}.
${CTX}
Read ${REF}/spec-precedence.md and apply the source precedence exactly. Every requirement needs an id (R1, R2, ...), a source and a confidence.
Mandatory: (1) list every conflict with the winning source and the reason; (2) anything that cannot be adjudicated goes to "unresolved" - do not decide it;
(3) questions from the PR author that the spec owner has not answered go to "pending_decisions"; (4) out-of-scope / follow-up sections go to "boundaries";
(5) constraints from related issues that apply to this PR go to "constraints"; (6) do NOT invent requirements; (7) merge duplicates but keep every source.
Sources that could not be read, or not read in full: ${j({ missingNotes, dropped: A.dropped || [] })}

Notes per source:
${j(notes)}`,
  { phase: 'Synthesize', label: 'synthesize-spec', schema: SPEC_SCHEMA }
)
if (!spec) throw new Error('Could not build the consolidated spec; stopping (no review without a spec)')
log(`Consolidated spec: ${spec.requirements.length} requirements, ${spec.conflicts.length} conflicts, ${spec.unresolved.length} unresolved, ${spec.pending_decisions.length} pending decisions`)
if (MODE === 'spec-only') return { mode: MODE, spec, notes, missingNotes }

// ---------- phase 3: Review (two independent passes) ----------
phase('Review')
const LENSES = ['topdown', 'bottomup']
const reviewPrompt = (lens) => `Review ${prMeta} on the "${lens}" route. This is an INDEPENDENT pass; you do not know the other pass's result.
${CTX}
References directory (REF): ${REF}. Read ${REF}/review-lenses.md and follow it (read code at head SHA ${T.headSha} with git show/git grep; base: origin/${T.baseRef}; re-check your own work once before returning).
${files}
${NO_WRITE}
CONSOLIDATED SPEC:
${j(spec)}`

const firstPass = await parallel(
  LENSES.map((l) => () => run('pr-code-reviewer', reviewPrompt(l), { phase: 'Review', label: `review:${l}`, schema: REVIEW_SCHEMA }))
)
const reviews = []
for (let i = 0; i < LENSES.length; i++) {
  let r = firstPass[i]
  if (!r) {
    log(`The ${LENSES[i]} pass returned nothing; running it once more`)
    r = await run('pr-code-reviewer', reviewPrompt(LENSES[i]), { phase: 'Review', label: `review:${LENSES[i]}:retry`, schema: REVIEW_SCHEMA })
  }
  reviews.push(r)
}
const degraded = reviews.some((r) => !r)
if (degraded) log('WARNING: one review pass is missing; the result does NOT meet the two-independent-passes requirement')

// Merge only the obvious duplicates (merging by meaning is Triage's job):
// same file + same category + at most 5 lines apart count as one point (sliding window, not fixed buckets).
const merged = []
reviews.forEach((r, i) => {
  if (!r) return
  for (const f of r.findings) {
    const same = merged.find((m) => m.file === f.file && m.category === f.category &&
      Math.abs((m.line || 0) - (f.line || 0)) <= 5)
    if (same) { if (!same.found_by.includes(LENSES[i])) same.found_by.push(LENSES[i]); continue }
    merged.push({ ...f, found_by: [LENSES[i]] })
  }
})
const findings = merged.map((f, i) => ({ ...f, id: `F${i + 1}` }))
log(`Review: topdown ${reviews[0] ? reviews[0].findings.length : 'n/a'}, bottomup ${reviews[1] ? reviews[1].findings.length : 'n/a'} -> ${findings.length} findings after the rough merge`)

// Cross-check coverage: requirements not met, or rated differently by the two passes, go to Triage.
const cov = {}
reviews.forEach((r, i) => {
  if (!r) return
  for (const c of r.coverage || []) { if (!cov[c.req_id]) cov[c.req_id] = {}; cov[c.req_id][LENSES[i]] = c }
})
const coverageIssues = Object.entries(cov)
  .filter(([, v]) => { const st = Object.values(v).map((x) => x.status); return new Set(st).size > 1 || st.some((s) => s !== 'met') })
  .map(([id, v]) => ({ req_id: id, ...v }))
const uncoveredReqs = spec.requirements.filter((r) => !cov[r.id]).map((r) => r.id)
if (uncoveredReqs.length) log(`Requirements that no pass rated for coverage: ${uncoveredReqs.join(', ')}`)

// ---------- phase 4: Verify ----------
phase('Verify')
const HIGH_SEV = ['CRITICAL', 'HIGH', 'MEDIUM']
const verifyPrompt = (f, lens) => `Try to REFUTE the following finding of the review of ${prMeta}, through the "${lens}" lens. Confirm only if you cannot refute it with evidence.
${CTX}
Read code at head SHA ${T.headSha} (git show/git grep). References directory (REF): ${REF}; read ${REF}/review-lenses.md (evidence discipline).
${files}
${NO_WRITE}
FINDING:
${j(f)}
CONSOLIDATED SPEC (to check scope, decisions and boundaries):
${j(spec)}`

async function verifyFinding(f) {
  const lenses = !A.fast && HIGH_SEV.includes(f.severity) ? ['runtime-trace', 'scope-and-coverage'] : ['runtime-trace']
  const out = await parallel(lenses.map((l) => () =>
    run('pr-finding-verifier', verifyPrompt(f, l), { phase: 'Verify', label: `verify:${f.id}:${l}`, schema: VERDICT_SCHEMA })
  ))
  const verdicts = out.map((v, i) => (v ? { lens: lenses[i], ...v } : null)).filter(Boolean)
  const vs = verdicts.map((v) => v.verdict)
  let status = 'unverified'
  if (vs.length) status = vs.every((v) => v === 'confirmed') ? 'confirmed' : vs.every((v) => v === 'refuted') ? 'refuted' : 'disputed'
  return { ...f, verdicts, status }
}

const verified = (await pipeline(findings, (f) => verifyFinding(f))).filter(Boolean)
const tally = verified.reduce((m, f) => { m[f.status] = (m[f.status] || 0) + 1; return m }, {})
log(`Verify: ${j(tally)}`)

// ---------- phase 5: Triage ----------
phase('Triage')
const triagePrompt = (list, label) => `Classify the verified findings of the review of ${prMeta} against the comment threshold.${label}
References directory (REF): ${REF}. Read ${REF}/commentability-gate.md and apply it EXACTLY (the four questions Q1-Q4 and the "what must the author do" test).
EVERY finding (refuted ones too) needs exactly one decision: MUST_COMMENT | SHOULD_COMMENT | CHAT_ONLY | DROP, with a short reason.
- Only finding_status "confirmed" may be MUST/SHOULD; "disputed"/"unverified" default to CHAT_ONLY (needs confirmation) unless the evidence is overwhelming;
  "refuted" -> DROP.
- Merge findings with the same root cause: keep one as the main one, DROP the others with merged_into.
- Read the PR description and the author's comments (${WS}/${T.path}) to drop points the author already raised or asked about (Q4).
- Every MUST/SHOULD needs a concrete author_action.
- Coverage gaps: look at "coverage_issues". A requirement rated unmet/partial/unclear, or rated differently by the two passes, with NO matching finding
  -> if you have evidence, add it to "additional" (full finding fields); if not, record it in coverage_notes. Do not invent.
- Respect the boundaries/decisions in the spec; points listed in "unresolved" or "pending_decisions" must not be used against the PR.
Do not post anything; ${NO_WRITE}

SPEC:
${j(spec)}

VERIFIED FINDINGS (status = finding_status):
${j(list.map((f) => ({ id: f.id, finding_status: f.status, found_by: f.found_by, title: f.title, severity: f.severity, category: f.category, file: f.file, line: f.line, claim: f.claim, evidence: f.evidence, failure_scenario: f.failure_scenario, spec_ref: f.spec_ref, verdicts: f.verdicts })))}

COVERAGE_ISSUES: ${j(coverageIssues)}
REQUIREMENTS NO PASS RATED: ${j(uncoveredReqs)}
SCOPE NOTES FROM THE REVIEWERS: ${j(reviews.map((r, i) => ({ lens: LENSES[i], scope_notes: r ? r.scope_notes : null })))}`

const triage = await agent(triagePrompt(verified, ''), { phase: 'Triage', label: 'triage', schema: TRIAGE_SCHEMA })

const triageFailed = !triage
let decisions = triage ? triage.decisions : []
let extras = []
if (triage && triage.additional.length) {
  const add = triage.additional.map((f, i) => ({ ...f, id: `X${i + 1}`, found_by: ['triage'] }))
  extras = (await pipeline(add, (f) => verifyFinding(f))).filter(Boolean)
  log(`Triage added ${add.length} findings from coverage gaps; confirmed ${extras.filter((f) => f.status === 'confirmed').length}`)
  decisions = decisions.concat(extras.map((f) => ({
    finding_id: f.id,
    class: f.status === 'confirmed' ? f.class : f.status === 'refuted' ? 'DROP' : 'CHAT_ONLY',
    reason: `added from coverage; verify=${f.status}`,
    author_action: f.author_action || '',
  })))
}
const allFindings = verified.concat(extras)
let decisionById = Object.fromEntries(decisions.map((d) => [d.finding_id, d]))

// Triage may not skip any finding (least of all a confirmed high-severity one). Ask again for exactly the missing ones, once.
let missing = allFindings.filter((f) => !decisionById[f.id])
if (missing.length) {
  log(`Triage skipped ${missing.length} findings (${missing.map((f) => f.id).join(', ')}); classifying them again`)
  const retry = await agent(triagePrompt(missing, '\nNOTE: the previous pass skipped the findings below; each one MUST get exactly one decision.'),
    { phase: 'Triage', label: 'triage:retry', schema: TRIAGE_SCHEMA })
  if (retry) {
    decisions = decisions.concat(retry.decisions)
    decisionById = Object.fromEntries(decisions.map((d) => [d.finding_id, d]))
  }
  missing = allFindings.filter((f) => !decisionById[f.id])
}
// Still missing: do NOT drop. Mark NEEDS_HUMAN so the skill reports it prominently.
for (const f of missing) {
  decisionById[f.id] = { finding_id: f.id, class: 'NEEDS_HUMAN', reason: `triage could not classify it (${f.severity}, ${f.status}); the reviewer must look at it directly`, author_action: '' }
  decisions.push(decisionById[f.id])
}
// Hard gate (independent of any prompt): only a finding the verifier CONFIRMED may be MUST/SHOULD_COMMENT.
// disputed/unverified/refuted are downgraded to CHAT_ONLY so the reviewer sees them but they never become comment suggestions.
const statusById = Object.fromEntries(allFindings.map((f) => [f.id, f.status]))
const downgraded = []
for (const d of decisions) {
  if ((d.class === 'MUST_COMMENT' || d.class === 'SHOULD_COMMENT') && statusById[d.finding_id] !== 'confirmed') {
    downgraded.push(`${d.finding_id}:${d.class}->CHAT_ONLY(${statusById[d.finding_id]})`)
    d.reason = `${d.reason} [downgraded: verify=${statusById[d.finding_id]}, not confirmed]`
    d.class = 'CHAT_ONLY'
  }
}
if (downgraded.length) log(`Downgraded because not confirmed: ${downgraded.join(', ')}`)
const unclassified = missing.map((f) => f.id)
if (unclassified.length) log(`WARNING: ${unclassified.length} findings were not classified and are marked NEEDS_HUMAN: ${unclassified.join(', ')}`)

// ---------- phase 6: Draft (suggestions only, nothing is posted) ----------
phase('Draft')
const toDraft = allFindings.filter((f) => {
  const d = decisionById[f.id]
  return d && (d.class === 'MUST_COMMENT' || d.class === 'SHOULD_COMMENT') && f.status === 'confirmed'
})
const drafts = (await pipeline(toDraft, (f) =>
  run('pr-comment-drafter',
    `Draft an inline comment suggestion (${COMMENT_LANG}) for the following finding of ${prMeta}. References directory (REF): ${REF}. Read ${REF}/comment-style.md.
Use the verified line: ${f.verdicts.map((v) => v.corrected_line).filter((x) => x != null)[0] || f.line}. ${NO_WRITE}
FINDING: ${j({ id: f.id, title: f.title, severity: f.severity, file: f.file, line: f.line, claim: f.claim, evidence: f.evidence, failure_scenario: f.failure_scenario, spec_ref: f.spec_ref })}
DECISION: ${j(decisionById[f.id])}`,
    { phase: 'Draft', label: `draft:${f.id}`, schema: DRAFT_SCHEMA }
  ).then((d) => (d ? { finding_id: f.id, class: decisionById[f.id].class, ...d } : null))
)).filter(Boolean)

const counts = decisions.reduce((m, d) => { m[d.class] = (m[d.class] || 0) + 1; return m }, {})
log(`Classification: ${j(counts)}; comment suggestions: ${drafts.length}`)

return {
  mode: MODE,
  pr: { number: T.number, headSha: T.headSha, baseRef: T.baseRef },
  degraded,
  triageFailed,
  spec,
  reviews: reviews.map((r, i) => ({ lens: LENSES[i], findingCount: r ? r.findings.length : null, scope_notes: r ? r.scope_notes : null, coverage: r ? r.coverage : null })),
  coverageIssues,
  uncoveredReqs,
  findings: allFindings,
  decisions,
  unclassified,
  drafts,
  coverageNotes: triage ? triage.coverage_notes : null,
  stats: { verifyTally: tally, decisionCounts: counts },
}
