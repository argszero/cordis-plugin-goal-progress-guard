/**
 * Compile-and-kill the defect arms for this plugin's decision points.
 *
 * An arm is a textual mutation of `src/index.ts` that reintroduces a specific
 * defect. The arm is compiled with the project's own `tsc` and the suite is run
 * against the rebuilt `lib/`:
 *
 * - the suite fails ⇒ the arm is **killed**, and the test that killed it is
 *   printed;
 * - the suite passes ⇒ the arm **survived**, which is a hole in the tests (or an
 *   equivalent mutant, which the arm must then argue for in its own comment);
 * - `tsc` refuses ⇒ the arm is **unbuildable**, which is not a kill: a mutation
 *   the type system rejects proves nothing about runtime coverage.
 *
 * The 0.2.0 arms exist because the published v0.1.0 got both halves of the jobs
 * seam wrong while 30 tests stayed green. The fixture was the accomplice: it
 * compared `job.owner?.id === caller?.id`, mirroring the implementation's own
 * mistake instead of the registry's contract. So the two arms that reproduce
 * v0.1.0's defects are the ones that matter most here — they are the difference
 * between "the tests pass" and "the tests would have caught it".
 *
 * Run with no arguments from the repository root:
 *
 *     npm run test:defects
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(root, 'src', 'index.ts')
const original = readFileSync(SRC, 'utf8')

/**
 * One arm: a name, why it is a defect, the exact text to change, and its
 * replacement.
 *
 * `find` must appear exactly once — an anchor that drifted is reported as
 * SKIPPED rather than silently mutating the wrong branch, because a mutation
 * harness that quietly stops matching measures nothing while looking green.
 */
const ARMS = [
  ['list-ignores-the-caller',
    'drops the caller, so only unowned jobs are ever visible',
    'return jobs.list(sessionId).filter(isUnsettled).length',
    'return jobs.list().filter(isUnsettled).length'],

  ['list-passes-the-agent',
    'hands the registry the agent at the call site — the v0.1.0 defect verbatim',
    '      unsettledJobs: unsettledJobs(sessionId),\n      unsettledSubagents: unsettledSubagents(sessionId),\n      capped,',
    '      unsettledJobs: unsettledJobs(agent as unknown as string),\n      unsettledSubagents: unsettledSubagents(sessionId),\n      capped,'],

  ['no-subscription',
    'installs the jobs service but never subscribes, so no settlement can arrive',
    "    jobsCtx.effect(() => jobs.events.subscribe({ owners: 'scope' }, (event) => {\n      if (event.type !== 'settled') return\n      guard.jobSettled(event.job?.owner)\n    }))",
    '    void jobsCtx'],

  ['subscribe-unscoped',
    'hears every composition in the process rather than the one it is mounted in',
    "jobs.events.subscribe({ owners: 'scope' }, (event) => {",
    "jobs.events.subscribe({ owners: 'all' }, (event) => {"],

  ['subscribe-to-one-owner',
    'pins the subscription to a single session instead of the mount scope',
    "jobs.events.subscribe({ owners: 'scope' }, (event) => {",
    "jobs.events.subscribe({ owner: 'dsh-a' }, (event) => {"],

  ['any-event-lifts',
    'treats every announcement as a settlement',
    "      if (event.type !== 'settled') return\n",
    ''],

  ['ignore-the-event-owner',
    'lifts every deferral on any settlement, whoever the job belongs to',
    'guard.jobSettled(event.job?.owner)',
    'guard.jobSettled(undefined)'],

  ['settlement-lifts-every-session',
    'stops reading which session the settled job names',
    'if (owner !== undefined) {\n      releaseSession(owner)\n      return\n    }',
    'if (owner !== undefined) {\n      for (const state of [...states.values()]) {\n        if (state.deferred !== undefined) release(state.deferred.agent, false)\n      }\n      return\n    }'],

  ['settle-nobody',
    'drops the owner lookup on the settlement path',
    'releaseSession(owner)',
    'void owner'],

  ['unobservable-reads-as-zero',
    'reports "no jobs service" as a count of zero instead of as unobservable',
    'if (jobs === undefined) return undefined',
    'if (jobs === undefined) return 0',
    // Equivalent, and provably so: `deferDecision` returns 'none' for both
    // `undefined` and `0`, and `resumeDecision` resumes for both (`?? 0`). The
    // distinction lives in the field's documented meaning, not in any behaviour
    // a test could observe. Recorded rather than dressed up as a kill.
    'equivalent'],

  ['child-count-ignores-origin',
    'counts any session naming this parent, so a fork is mistaken for delegated work',
    "return header?.origin === 'subagent' && header.parentSession === parentSessionId",
    'return header?.parentSession === parentSessionId'],

  ['child-count-ignores-status',
    'counts a passed-off child, so residency is treated as work in flight',
    "if (agent.status !== 'running') return false\n",
    ''],

  ['child-count-ignores-parent',
    'counts every running delegated child, whoever it belongs to',
    '  return header?.origin === \'subagent\' && header.parentSession === parentSessionId',
    "  return header?.origin === 'subagent'"],

  ['no-child-release',
    'never reconsiders a parent when a child goes quiescent: the goal stays paused',
    '    guard.evaluate(payload.agent)\n    guard.childSettled(payload.agent)\n  }, { prepend: true })',
    '    guard.evaluate(payload.agent)\n  }, { prepend: true })'],

  ['no-disposed-release',
    'never reconsiders a parent when a child is disposed',
    '  on(\'agent/disposed\', (payload: { agent: unknown }) => {\n    guard.childSettled(payload.agent)\n    guard.forget(payload.agent)\n  })',
    '  on(\'agent/disposed\', (payload: { agent: unknown }) => {\n    guard.forget(payload.agent)\n  })'],

  ['no-agents-injection',
    'installs no registry, so the child dimension is inert in every composition',
    "  ctx.inject(['agents'], (agentsCtx) => {\n    guard.attachAgents((agentsCtx as unknown as { agents: AgentsLike }).agents)\n  })",
    '  void 0'],

  ['child-settlement-releases-itself',
    "releases the child's own session instead of its parent's",
    '    releaseSession(parent)',
    '    releaseSession((agent as AgentLike).id)'],

  ['no-deadline-armed',
    'never arms the cap, so a stuck child holds the goal for as long as the composition lives',
    'const maxDeferMs = config.maxDeferMs',
    'const maxDeferMs = undefined as number | undefined'],

  ['deadline-fires-on-settlement',
    'treats an ordinary settlement as if the deadline had elapsed',
    '    release(state.deferred.agent, false)',
    '    release(state.deferred.agent, true)'],

  ['cap-never-suppresses',
    're-pauses immediately after the deadline released a round, so no round is ever taken',
    "  if (observed.capped) return 'none'\n",
    ''],

  ['capped-rounds-are-judged',
    'charges the deadline-released rounds to drift, stopping a goal whose work still runs',
    '    if (state.capped) {\n      state.lastRoundsStarted = goal.roundsStarted\n      state.toolCallsInWindow = 0\n      return\n    }\n',
    ''],

  ['cap-never-clears',
    'keeps suppressing deferrals after the work they waited for has drained',
    '    if (pendingWork(observed) === 0) state.capped = false\n',
    ''],
]

const results = []

for (const [arm, description, find, replace, note] of ARMS) {
  const occurrences = original.split(find).length - 1
  if (occurrences !== 1) {
    results.push({ arm, description, outcome: `SKIPPED — anchor appears ${occurrences}×, not once`, note })
    continue
  }

  writeFileSync(SRC, original.replace(find, replace))
  let outcome
  try {
    execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' })
  } catch (error) {
    const first = String(error.stderr ?? error).trim().split('\n').filter(Boolean)[0] ?? 'no diagnostic'
    outcome = `UNBUILDABLE — ${first}`
  }

  if (outcome === undefined) {
    try {
      execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' })
      outcome = note === 'equivalent'
        ? 'survived — equivalent mutant, see the arm comment'
        : 'SURVIVED — a hole in the tests'
    } catch (error) {
      const out = String(error.stdout ?? '')
      const failing = (out.match(/^✖ (.*)$/gm) ?? []).map(line => line.slice(2)).slice(0, 2)
      outcome = `killed — ${failing.length > 0 ? failing.join(' | ') : 'a test failed'}`
    }
  }

  results.push({ arm, description, outcome, note })
  process.stdout.write('.')
}

writeFileSync(SRC, original)
execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'pipe' })
execFileSync('npm', ['test'], { cwd: root, stdio: 'pipe' })
if (readFileSync(SRC, 'utf8') !== original) {
  throw new Error('the source was not restored — restore it before doing anything else')
}

console.log('\n')
for (const { arm, description, outcome, note } of results) {
  const mark = outcome.startsWith('killed') ? '✔'
    : outcome.startsWith('SKIPPED') || outcome.startsWith('UNBUILDABLE') ? '!'
      : note === 'equivalent' ? '≡' : '✘'
  console.log(`${mark} ${arm}\n    ${description}\n    ${outcome}`)
}

const killed = results.filter(r => r.outcome.startsWith('killed')).length
const equivalent = results.filter(r => r.note === 'equivalent' && r.outcome.startsWith('survived')).length
const unaccounted = results.length - killed - equivalent
console.log(`\n${killed}/${results.length} arms killed, ${equivalent} equivalent, `
  + `${unaccounted} unaccounted for. Source restored, rebuilt and re-tested clean.`)
if (unaccounted > 0) process.exitCode = 1
