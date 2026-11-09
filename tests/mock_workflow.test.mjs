// Runs pr-review.workflow.js with fake globals (no network, no real agents) and asserts the hard gates.
// Usage: node tests/mock_workflow.test.mjs
import { readFileSync } from 'node:fs'
import assert from 'node:assert/strict'

const src = readFileSync(new URL('../skills/pr-review/scripts/pr-review.workflow.js', import.meta.url), 'utf8')
  .replace('export const meta =', 'const meta =')
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

const baseArgs = {
  mode: 'pr', skillDir: '/plugin/skills/pr-review', agentNamespace: 'pr-review-harness',
  config: { projectContext: 'demo', conventionDocs: ['CLAUDE.md'], commentLanguage: 'English' },
  workspace: '/ws', repo: 'o/r',
  target: { number: 7, title: 'T', author: 'a', state: 'OPEN', baseRef: 'main', headRef: 'f', headSha: 'abc', path: 'pr.json', diffPath: 'diff.patch', changedFilesPath: 'changed_files.txt' },
  sources: [{ number: 1, kind: 'issue', depth: 0, via: 'closing-ref', state: 'OPEN', title: 'I', path: 'sources/issue-1.json' }],
  dropped: [], extra: [],
}

function fakes({ reviewNull = false, namespaced = false } = {}) {
  const calls = []
  const finding = (n, line, sev) => ({ title: `f${n}`, severity: sev, category: 'bug', file: `a${n}.rb`, line, claim: 'c', evidence: 'e', failure_scenario: 's' })
  const agent = async (prompt, opts) => {
    calls.push({ label: opts.label, agentType: opts.agentType })
    if (opts.agentType && opts.agentType.startsWith('pr-review-harness:') && !namespaced) throw new Error('unknown agent type')
    const l = opts.label
    if (l.startsWith('spec:')) return { source: l, summary: 's', requirements: [], decisions: [], boundaries: [], pending_questions: [] }
    if (l === 'synthesize-spec') return { summary: 's', requirements: [{ id: 'R1', text: 't', source: '#1', authority: 'body', status: 'explicit' }, { id: 'R2', text: 't', source: '#1', authority: 'body', status: 'explicit' }], boundaries: [], constraints: [], conflicts: [], unresolved: [], pending_decisions: [] }
    if (l.startsWith('review:')) {
      if (reviewNull && l.startsWith('review:bottomup')) return null
      const top = l.includes('topdown')
      return { findings: top ? [finding(1, 10, 'HIGH'), finding(2, 20, 'MEDIUM'), finding(3, 30, 'LOW')] : [finding(1, 12, 'HIGH'), finding(4, 40, 'LOW')],
        coverage: [{ req_id: 'R1', status: 'met', evidence: 'x' }], scope_notes: '' }
    }
    if (l.startsWith('verify:')) {
      const id = l.split(':')[1]
      if (id === 'F1') return { verdict: 'confirmed', reason: 'r', evidence: 'e', corrected_line: 11 }
      if (id === 'F2') return { verdict: l.endsWith('runtime-trace') ? 'confirmed' : 'refuted', reason: 'r', evidence: 'e' }  // disputed
      if (id === 'F3') return { verdict: 'refuted', reason: 'r', evidence: 'e' }
      return { verdict: 'confirmed', reason: 'r', evidence: 'e' }  // F4, forgotten by triage
    }
    if (l === 'triage') return { decisions: [
      { finding_id: 'F1', class: 'MUST_COMMENT', reason: 'r', author_action: 'fix it' },
      { finding_id: 'F2', class: 'SHOULD_COMMENT', reason: 'r', author_action: 'add test' },  // must be downgraded: disputed
      { finding_id: 'F3', class: 'DROP', reason: 'r' }], additional: [], coverage_notes: '' }
    if (l === 'triage:retry') return { decisions: [], additional: [], coverage_notes: '' }  // still skips F4
    if (l.startsWith('draft:')) return { path: 'a1.rb', line: 11, side: 'RIGHT', severity_tag: '[must]', body: 'x' }
    throw new Error('unexpected label ' + l)
  }
  const parallel = async (ts) => Promise.all(ts.map((t) => t().catch(() => null)))
  const pipeline = async (items, ...stages) => Promise.all(items.map(async (it, i) => {
    try { let v = it; for (const s of stages) v = await s(v, it, i); return v } catch { return null }
  }))
  return { agent, parallel, pipeline, calls, logs: [] }
}

async function run(args, opts) {
  const f = fakes(opts)
  const fn = new AsyncFunction('args', 'agent', 'parallel', 'pipeline', 'phase', 'log', src)
  const result = await fn(args, f.agent, f.parallel, f.pipeline, () => {}, (m) => f.logs.push(m))
  return { result, ...f }
}

// 1) full run: gates
{
  const { result, logs } = await run(baseArgs)
  const cls = Object.fromEntries(result.decisions.map((d) => [d.finding_id, d.class]))
  assert.equal(cls.F1, 'MUST_COMMENT', 'confirmed finding keeps MUST')
  assert.equal(cls.F2, 'CHAT_ONLY', 'disputed finding is downgraded from SHOULD')
  assert.equal(cls.F3, 'DROP')
  assert.equal(cls.F4, 'NEEDS_HUMAN', 'a finding triage skipped is never dropped silently')
  assert.deepEqual(result.unclassified, ['F4'])
  assert.equal(result.drafts.length, 1, 'only the confirmed MUST gets a draft')
  assert.equal(result.findings.find((f) => f.id === 'F1').found_by.length, 2, 'lines 10 and 12 merge into one finding')
  assert.equal(result.degraded, false)
  assert.ok(logs.some((m) => m.includes('Downgraded')))
  console.log('ok  full run: gates, merge window, NEEDS_HUMAN, drafts')
}

// 2) agent name resolution: the namespaced name fails, the bare name is used afterwards
{
  const { calls } = await run(baseArgs)
  const bare = calls.filter((c) => c.agentType === 'pr-code-reviewer').length
  assert.ok(bare >= 2, 'falls back to the bare agent name')
  console.log('ok  namespaced -> bare agent name fallback')
}

// 3) namespaced name works: it is used and cached
{
  const { calls } = await run(baseArgs, { namespaced: true })
  assert.ok(calls.some((c) => c.agentType === 'pr-review-harness:pr-spec-analyst'))
  console.log('ok  namespaced agent name used when available')
}

// 4) a missing review pass -> degraded
{
  const { result } = await run(baseArgs, { reviewNull: true })
  assert.equal(result.degraded, true)
  console.log('ok  missing review pass sets degraded')
}

// 5) spec-only mode returns before any review
{
  const { result, calls } = await run({ ...baseArgs, mode: 'spec-only' })
  assert.equal(result.mode, 'spec-only')
  assert.ok(!calls.some((c) => c.label.startsWith('review:')))
  console.log('ok  spec-only stops after Synthesize')
}

// 6) missing skillDir is rejected
{
  const { skillDir, ...bad } = baseArgs
  await assert.rejects(run(bad), /skillDir/)
  console.log('ok  args without skillDir are rejected')
}
