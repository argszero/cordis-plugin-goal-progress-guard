/**
 * Behaviour of @argszero/cordis-plugin-goal-progress-guard.
 *
 * Two layers, deliberately separated:
 *
 * - the pure policy functions, exhaustively, with no harness at all;
 * - the mounted plugin, driven through a **real cordis `Context`** against
 *   stubs that enforce the real services' rules (the CAS ref must be the
 *   revision that was read; `block` and `pause` require an `active` goal;
 *   `resume` refuses an already-armed goal and one out of rounds; the block
 *   reason must satisfy the harness validator).
 *
 * Nothing here starts, stops or talks to a daemon; no network, no filesystem.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import {
  Config,
  advanceBarrenStreak,
  apply,
  blockDecision,
  createProgressGuard,
  deferDecision,
  inject,
  isToolCallEvent,
  isUnsettled,
  isRunningChild,
  mountLine,
  name,
  pendingWork,
  resumeDecision,
} from '../lib/index.js'

// ------------------------------------------------------------------ fixtures

/**
 * The reason validator the real goal service applies, copied verbatim from
 * `packages/goal/goal/src/index.ts` (`resolveBlockReason`). A code that fails
 * this is one the harness would reject with `GOAL_INVALID_BLOCK_REASON` at the
 * moment the plugin tries to stop a runaway goal.
 */
const BLOCK_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

/** A current goal view, shaped as `GoalView` shapes it. */
function view({ id = 'g1', revision = 4, phase = 'active', roundsStarted = 0, activation = 'armed' } = {}) {
  return {
    id,
    revision,
    phase,
    activation,
    roundsStarted,
    maxGoalRounds: 256,
    objective: 'ship it',
    createdAt: 0,
    updatedAt: 0,
  }
}

/**
 * A `goals` service stand-in that enforces the real service's rules.
 * @param options - the current goal view, its owning agent id, and optional forced failures.
 * @returns the service, the calls it accepted, and the mutable goal holder.
 */
function goalsService({ goal = undefined, owner = undefined, getThrows = false, pauseThrows = false, blockThrows = false } = {}) {
  const pauses = []
  const resumes = []
  const blocks = []
  const state = { goal }
  const current = () => state.goal
  const bump = (next) => {
    state.goal = { ...current(), ...next, revision: current().revision + 1 }
    return state.goal
  }
  const service = {
    get(agent) {
      if (getThrows) throw new Error('goal "g1" is not the live agent instance')
      assert.equal(typeof agent, 'object', 'the goal service is always called with the live agent')
      // A goal belongs to one live agent. Without this the fixture would hand
      // every session the same goal, which is how a child's own quiescent edge
      // could be mistaken for the parent's.
      if (owner !== undefined && agent?.id !== owner) return undefined
      return current()
    },
    pause(agent, ref) {
      if (pauseThrows) throw new Error('GOAL_INVALID_TRANSITION: goal "g1" cannot be paused')
      assert.equal(ref.id, current().id, 'the CAS ref must carry the id that was read')
      assert.equal(ref.revision, current().revision, 'the CAS ref must carry the revision that was read')
      assert.equal(current().phase, 'active', 'only an active goal may be paused')
      pauses.push({ agent, ref })
      return bump({ phase: 'paused', activation: 'disarmed' })
    },
    resume(agent, ref) {
      assert.equal(ref.id, current().id, 'the CAS ref must carry the id that was read')
      assert.equal(ref.revision, current().revision, 'the CAS ref must carry the revision that was read')
      assert.ok(['active', 'paused', 'blocked'].includes(current().phase), 'only a resumable phase may resume')
      assert.ok(!(current().phase === 'active' && current().activation === 'armed'), 'an armed goal is already running')
      assert.ok(current().roundsStarted < current().maxGoalRounds, 'a goal out of rounds may not resume')
      resumes.push({ agent, ref })
      return bump({ phase: 'active', activation: 'armed' })
    },
    block(agent, ref, reason) {
      if (blockThrows) throw new Error('GOAL_INVALID_TRANSITION: goal "g1" has an invalid phase transition')
      assert.equal(ref.id, current().id, 'the CAS ref must carry the id that was read')
      assert.equal(ref.revision, current().revision, 'the CAS ref must carry the revision that was read')
      assert.equal(current().phase, 'active', 'only an active goal may be blocked')
      assert.match(reason.code, BLOCK_CODE, 'the reason code the harness accepts is lower-kebab-case')
      assert.ok(typeof reason.message === 'string' && reason.message.trim().length > 0, 'the reason message must be non-empty')
      blocks.push({ agent, ref, reason })
      return bump({ phase: 'blocked', activation: 'disarmed', blockedReason: reason })
    },
  }
  return { service, pauses, resumes, blocks, state }
}

/**
 * A `jobs` service stand-in carrying **exactly the documented surface**.
 *
 * This fixture is the regression guard for a defect class that shipped once, in
 * v0.1.0: the plugin called `list(agent)` and read settlements from a
 * per-listener `onJobDone` hook. The registry's real terms are that `list` takes
 * the caller's **session id** — `JobView.owner` is that id, never the `Agent` —
 * and that settlements arrive on its one event stream,
 * `events.subscribe(filter, listener)`; the three listener families
 * (`onJobDone`, `onJobsChanged`, `onOutput`) were removed by the 2026-09-03 jobs
 * seam consolidation, and `JobView.owner` stopped being an `Agent` at the same
 * time.
 *
 * So the fixture **enforces the contract instead of mirroring the caller**: it
 * asserts the caller is a string, and it offers no settlement hook to call. A
 * stand-in that accepted the agent (v0.1.0's own fixture compared
 * `job.owner?.id === caller?.id`) is exactly what let the defect through a green
 * suite — the implementation and its twin were wrong together.
 */
function jobsService({ jobs = [] } = {}) {
  const listeners = new Set()
  const state = { jobs: jobs.map(job => ({ ...job })) }
  const callers = []
  const filters = []

  /** The visible set, filtered the way the registry filters it. */
  const visible = (caller) => {
    assert.ok(caller === undefined || typeof caller === 'string',
      'jobs.list() takes the caller session id: the registry compares it against the owning session, so an Agent matches nothing')
    return state.jobs.filter(job => job.owner === undefined || job.owner === caller)
  }

  return {
    state,
    /** Every caller `list` was invoked with, in order. */
    callers,
    /** Every filter `events.subscribe` was invoked with, in order. */
    filters,
    /** Hand one event to the subscribers, the way the registry routes it. */
    announce(event) {
      for (const listener of [...listeners]) listener(event)
    },
    /**
     * Settle one job's recorded state **without** announcing anything.
     *
     * This is what gives a negative assertion its teeth: with the job already
     * settled in the registry, a lift the plugin attempts succeeds, so a test
     * that expects no resume is measuring the plugin's decision rather than a
     * job that merely refuses to go away.
     */
    markSettled(id, status = 'completed') {
      const job = state.jobs.find(candidate => candidate.id === id)
      if (job === undefined) throw new Error(`no such job: ${id}`)
      job.status = status
    },
    /** Settle one job and announce it, the way the registry does. */
    settle(id, status = 'completed') {
      const job = state.jobs.find(candidate => candidate.id === id)
      if (job === undefined) throw new Error(`no such job: ${id}`)
      job.status = status
      this.announce({
        type: 'settled',
        job: { ...job },
        cause: status === 'killed' ? 'kill' : 'producer',
        awaited: false,
      })
    },
    service: {
      list(caller) {
        callers.push(caller)
        return visible(caller).map(job => ({ ...job }))
      },
      events: {
        subscribe(filter, listener) {
          filters.push(filter)
          listeners.add(listener)
          return () => listeners.delete(listener)
        },
      },
    },
  }
}

/** A minimal agent stand-in: the plugin only ever reads `agent.id`, `agent.status` and `agent.session`. */
function liveAgent(id, { status = 'idle', header } = {}) {
  return { id, status, session: { id, ...(header === undefined ? {} : { header }) } }
}

/**
 * A delegated child's durable header, as `childSessionMeta` stamps it.
 *
 * Copied from `packages/subagent/subagent/src/child-agent.ts`: the parent's id
 * under `parentSession`, and the coarse `origin: 'subagent'`. A **fork** writes
 * `parentSession` too and leaves `origin` unset, which is exactly the
 * difference the child predicate is built on.
 */
function childHeader(parentSession) {
  return {
    version: 4,
    id: 'child',
    createdAt: 0,
    parentSession,
    isSeeded: true,
    origin: 'subagent',
    delegationDepth: 1,
  }
}

/** A forked session's durable header: lineage without delegation. */
function forkHeader(parentSession) {
  return { version: 4, id: 'fork', createdAt: 0, parentSession, isSeeded: true }
}

/**
 * An `agents` service stand-in carrying **exactly the documented surface**.
 *
 * The real registry publishes `list()` — every live agent — and `get(id)`. This
 * plugin calls `list` only, and it has to be the *live* registry rather than a
 * durable projection: a session-query catalog entry carries no liveness at all,
 * and the whole point of the child dimension is "is it running *now*". The
 * fixture therefore offers no catalog method to reach for by mistake.
 *
 * @param agents - the live agents the registry would report.
 * @returns the stub, with its mutable agent list.
 */
function agentsService(agents = []) {
  const state = { agents: [...agents] }
  return {
    state,
    service: { list: () => [...state.agents] },
  }
}

/**
 * A `schedule` stand-in that captures the armed callbacks instead of waiting.
 *
 * The mounted plugin arms real timers, which no test may depend on for a
 * decision; this stand-in makes "did the deadline fire" a synchronous choice.
 */
function scheduler() {
  const armed = []
  return {
    armed,
    /** Fire every callback that is still armed, oldest first. */
    fireAll() {
      for (const entry of [...armed]) {
        if (!entry.cancelled) entry.fire()
      }
    },
    schedule(fire, delayMs) {
      const entry = { fire, delayMs, cancelled: false }
      armed.push(entry)
      return () => { entry.cancelled = true }
    },
  }
}

/** A durable tool call, shaped as `Session.append` produces it. */
function toolCallEvent() {
  return { type: 'tool/call', data: { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } }
}

/** A durable user message, the shape the no-progress window must not mistake for work. */
function userMessageEvent() {
  return { type: 'user/message', data: { id: 'm1', source: { kind: 'user' } } }
}

/**
 * Mount the plugin the way the loader does — passing the whole module, so
 * `inject` travels with it (a hand-built mount that omits `inject` silently
 * drops the dependency).
 *
 * `jobs` and `agents` are provided only when a test passes one, which is also
 * how the "composition without background jobs / without an agent registry"
 * cases are exercised: neither is required by `inject`, and both dimensions
 * must be inert without them.
 *
 * @param options - plugin config and the stub services to provide.
 * @returns the mounted context and the stubs.
 */
async function mount({ config = {}, goals, jobs, agents } = {}) {
  const ctx = new Context()
  ctx.provide('goals', goals.service)
  if (jobs !== undefined) ctx.provide('jobs', jobs.service)
  if (agents !== undefined) ctx.provide('agents', agents.service)
  await ctx.plugin({ name, inject, apply, Config }, config)
  return { ctx, goals, jobs, agents }
}

// ------------------------------------------------------------- the pure policy

test('advanceBarrenStreak: only a settled round is judged, and only an empty one counts', () => {
  assert.equal(advanceBarrenStreak({ barrenStreak: 0, roundSettled: false, toolCalls: 0 }), 0,
    'a window with no admitted round is not evidence of drift')
  assert.equal(advanceBarrenStreak({ barrenStreak: 2, roundSettled: false, toolCalls: 0 }), 0,
    'and it clears a streak that was building — the human is supervising')
  assert.equal(advanceBarrenStreak({ barrenStreak: 0, roundSettled: true, toolCalls: 0 }), 1)
  assert.equal(advanceBarrenStreak({ barrenStreak: 2, roundSettled: true, toolCalls: 0 }), 3)
  assert.equal(advanceBarrenStreak({ barrenStreak: 2, roundSettled: true, toolCalls: 1 }), 0,
    'one tool call is enough to be work')
})

test('deferDecision: only an armed, active goal with observable pending work defers', () => {
  const armed = {
    deferWhileJobsPending: true,
    deferWhileSubagentsPending: true,
    phase: 'active',
    activation: 'armed',
    unsettledJobs: 1,
    unsettledSubagents: 0,
    capped: false,
  }
  assert.equal(deferDecision(armed), 'defer')
  assert.equal(deferDecision({ ...armed, deferWhileJobsPending: false }), 'none', 'the dimension can be switched off')
  assert.equal(deferDecision({ ...armed, phase: 'paused' }), 'none', 'a paused goal has nothing to defer')
  assert.equal(deferDecision({ ...armed, phase: 'blocked' }), 'none')
  assert.equal(deferDecision({ ...armed, activation: 'disarmed' }), 'none', 'a disarmed goal is not taking rounds')
  assert.equal(deferDecision({ ...armed, unsettledJobs: 0 }), 'none')
  assert.equal(deferDecision({ ...armed, unsettledJobs: undefined }), 'none',
    'an unobservable job count must never defer — that is the composition without a jobs service')
  assert.equal(deferDecision({ ...armed, unsettledJobs: 0, unsettledSubagents: 1 }), 'defer',
    'a running delegated child is the same reason to wait as a job')
  assert.equal(deferDecision({ ...armed, unsettledJobs: 0, unsettledSubagents: 1, deferWhileSubagentsPending: false }), 'none',
    'and that dimension can be switched off on its own')
  assert.equal(deferDecision({ ...armed, unsettledJobs: 0, unsettledSubagents: undefined }), 'none',
    'an unobservable child count never defers either')
  assert.equal(deferDecision({ ...armed, capped: true }), 'none',
    'a goal whose deadline already released a round is not waived away again')
})

test('pendingWork: a disabled or unobservable dimension is not work the guard is waiting for', () => {
  const base = { deferWhileJobsPending: true, deferWhileSubagentsPending: true }
  assert.equal(pendingWork({ ...base, unsettledJobs: 2, unsettledSubagents: 3 }), 5)
  assert.equal(pendingWork({ ...base, unsettledJobs: undefined, unsettledSubagents: 3 }), 3,
    'an unobservable count contributes nothing — it can never be why a deferral is held')
  assert.equal(pendingWork({ ...base, unsettledJobs: 2, unsettledSubagents: undefined }), 2)
  assert.equal(pendingWork({ ...base, unsettledJobs: undefined, unsettledSubagents: undefined }), 0)
  assert.equal(pendingWork({ ...base, deferWhileJobsPending: false, unsettledJobs: 9, unsettledSubagents: 1 }), 1,
    'a disabled dimension is not counted even when it is observable')
  assert.equal(pendingWork({ deferWhileJobsPending: false, deferWhileSubagentsPending: false, unsettledJobs: 9, unsettledSubagents: 9 }), 0)
})

test('blockDecision: unset is unenforced, and a goal that is not active is never stopped', () => {
  assert.equal(blockDecision({ maxBarrenRounds: undefined, barrenStreak: 99, phase: 'active' }), undefined)
  assert.equal(blockDecision({ maxBarrenRounds: 3, barrenStreak: 2, phase: 'active' }), undefined)
  assert.equal(blockDecision({ maxBarrenRounds: 3, barrenStreak: 3, phase: 'paused' }), undefined,
    'a goal this plugin deferred must not be converted into a stop')
  const reason = blockDecision({ maxBarrenRounds: 3, barrenStreak: 3, phase: 'active' })
  assert.equal(reason.code, 'no-progress')
  assert.match(reason.message, /3 consecutive rounds/)
})

test('resumeDecision: a goal moved by someone else is forgotten, not fought over', () => {
  const base = { unsettledJobs: 0, unsettledSubagents: 0, deadlineReached: false }
  assert.equal(resumeDecision({ ...base, phase: 'paused' }), 'resume')
  assert.equal(resumeDecision({ ...base, phase: 'paused', unsettledJobs: 2 }), 'none')
  assert.equal(resumeDecision({ ...base, phase: 'paused', unsettledSubagents: 1 }), 'none',
    'a running child holds the deferral exactly as a job does')
  assert.equal(resumeDecision({ ...base, phase: 'active' }), 'forget', 'a human already resumed it')
  assert.equal(resumeDecision({ ...base, phase: 'blocked' }), 'forget')
  assert.equal(resumeDecision({ ...base, phase: 'absent' }), 'forget', 'the goal is gone')
  assert.equal(resumeDecision({ ...base, phase: 'paused', unsettledJobs: undefined }), 'resume',
    'an unobservable job count resumes: a deferral this plugin cannot lift would strand the goal')
  assert.equal(resumeDecision({ ...base, phase: 'paused', unsettledSubagents: undefined }), 'resume',
    'and so does an unobservable child count')
  assert.equal(resumeDecision({ ...base, phase: 'paused', unsettledJobs: 5, unsettledSubagents: 5, deadlineReached: true }), 'resume',
    'the deadline outranks work that is still observable: work which never ends would hold the goal forever')
})

test('isUnsettled: a job being killed has not settled', () => {
  assert.equal(isUnsettled({ status: 'running' }), true)
  assert.equal(isUnsettled({ status: 'stopping' }), true)
  for (const status of ['completed', 'killed', 'failed']) assert.equal(isUnsettled({ status }), false)
  assert.equal(isUnsettled({}), false, 'an absent status is not an unsettled job')
})

test('isToolCallEvent recognises exactly the durable tool call', () => {
  assert.equal(isToolCallEvent(toolCallEvent()), true)
  assert.equal(isToolCallEvent(userMessageEvent()), false)
  assert.equal(isToolCallEvent({ type: 'tool/result', data: {} }), false, 'a result is not a call')
  assert.equal(isToolCallEvent(undefined), false)
})

test('mountLine states what the guard will do, including that it is inert', () => {
  assert.match(mountLine({}), /deferWhileJobsPending=on, deferWhileSubagentsPending=on, maxDeferMs=unset, maxBarrenRounds=unset/)
  assert.doesNotMatch(mountLine({}), /inert/, 'the default configuration does enforce both deferral dimensions')
  assert.doesNotMatch(mountLine({ deferWhileJobsPending: false }), /inert/,
    'one disabled dimension is not an inert guard while the other still waits')
  assert.match(mountLine({ deferWhileJobsPending: false, deferWhileSubagentsPending: false, maxBarrenRounds: undefined }), /inert/)
  assert.match(mountLine({ maxBarrenRounds: 3, dryRun: true }), /maxBarrenRounds=3 \(dry-run\)/)
  assert.match(mountLine({ maxDeferMs: 60000 }), /maxDeferMs=60000/)
})

test('every reason code the plugin can emit is one the harness validator accepts', () => {
  const codes = [blockDecision({ maxBarrenRounds: 1, barrenStreak: 1, phase: 'active' })?.code]
  assert.deepEqual(codes.filter(code => code === undefined), [], 'the fixture must actually produce a code')
  for (const code of codes) {
    assert.match(code, BLOCK_CODE, `"${code}" would be rejected with GOAL_INVALID_BLOCK_REASON`)
  }
})

// ------------------------------------------------- control arm and the mounted plugin

test('control arm: without the plugin, an idle agent with a running job is left alone', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const ctx = new Context()
  ctx.provide('goals', goals.service)
  ctx.provide('jobs', jobs.service)
  for (const status of ['running', 'idle', 'running', 'idle']) ctx.emit('agent/status', { agent, status })
  assert.deepEqual(goals.pauses, [], 'the fixture alone never pauses, so a pause below is this plugin acting')
  assert.deepEqual(goals.blocks, [])
})

test('a goal is paused while its job runs, and resumed when that job settles', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.pauses.length, 1, 'the loop stops while there is something to wait for')
  assert.equal(goals.state.goal.phase, 'paused')

  jobs.settle('j1')
  assert.equal(goals.resumes.length, 1, 'the loop restarts when the work it waited for is done')
  assert.equal(goals.state.goal.phase, 'active')
  assert.equal(goals.state.goal.activation, 'armed')
})

test('the job lookup asks for the session id, never the agent', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })

  // The fixture asserts the type; this asserts what it costs to get it wrong.
  assert.deepEqual(jobs.callers, ['dsh-a'],
    'JobRegistry.list takes the caller session id — an Agent matches no owned job')
  assert.equal(goals.pauses.length, 1,
    'and the owned job is what deferred it, which only a matching caller can see')
})

test('the settlement rides the registry event stream, and only a settlement lifts a deferral', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  assert.deepEqual(jobs.filters, [{ owners: 'scope' }],
    'settlements arrive on jobs.events.subscribe — the per-listener onJobDone hook no longer exists')

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)

  // From here the job is settled in the registry, so ANY lift the plugin
  // attempts succeeds. What the three announcements below measure is therefore
  // the plugin's decision, not an unsettled job holding the deferral open: with
  // the job still running, every one of them would "pass" for the wrong reason.
  jobs.markSettled('j1')
  const settledEvent = (owner) => ({ type: 'settled', job: { id: 'j1', status: 'completed', owner }, cause: 'producer', awaited: false })

  jobs.announce({ type: 'progress', job: { id: 'j1', status: 'completed', owner: 'dsh-a' } })
  assert.deepEqual(goals.resumes, [], 'a progress line is not a settlement')

  jobs.announce(settledEvent('dsh-other'))
  assert.deepEqual(goals.resumes, [], "another session's job says nothing about this one")

  jobs.announce(settledEvent('dsh-a'))
  assert.equal(goals.resumes.length, 1, 'the session the settled job names is the one released')
})

test('the plugin touches only members the jobs service actually publishes', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })

  // The plugin reaches for a member that is absent from this stand-in only if it
  // is coded against a contract the registry does not publish — which is how
  // v0.1.0 came to call `jobs.onJobDone`, a hook removed on 2026-09-03. Property
  // reads are what a removed *method* looks like from the outside: the read
  // succeeds and yields `undefined`, so only the read itself is observable here.
  const touched = new Set()
  const watched = new Proxy(jobs.service, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') touched.add(prop)
      return Reflect.get(target, prop, receiver)
    },
  })

  const ctx = new Context()
  ctx.provide('goals', goals.service)
  ctx.provide('jobs', watched)
  await ctx.plugin({ name, inject, apply, Config }, {})
  ctx.emit('agent/status', { agent, status: 'idle' })
  jobs.settle('j1')

  assert.deepEqual([...touched].sort(), ['events', 'list'],
    'the jobs service publishes list(caller) and events.subscribe(filter, listener) — nothing else')
  assert.equal(goals.resumes.length, 1, 'and both of the members it did touch are the ones that work')
})

test('the deferral happens before the driver could have queued the next round', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const ctx = new Context()
  ctx.provide('goals', goals.service)
  ctx.provide('jobs', jobs.service)

  // A listener registered *before* the plugin, standing in for the goal-round
  // driver's own `agent/status` listener. It records the phase it observes.
  const observed = []
  ctx.on('agent/status', () => { observed.push(goals.state.goal.phase) })

  await ctx.plugin({ name, inject, apply, Config }, {})
  ctx.emit('agent/status', { agent, status: 'idle' })

  assert.deepEqual(observed, ['paused'],
    'the guard must be prepended: the driver queues a round synchronously when it has no pending checkpoint')
})

test('a deferral does not advance the barren streak, and a resumed round is judged normally', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ config: { maxBarrenRounds: 1 }, goals, jobs })

  // Two quiescent edges with a pending job: waiting, not drifting.
  ctx.emit('agent/status', { agent, status: 'idle' })
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.deepEqual(goals.blocks, [], 'a round that ended in order to wait produced nothing on purpose')

  // The job settles, the goal resumes, and the next round does nothing at all.
  jobs.settle('j1')
  goals.state.goal = { ...goals.state.goal, roundsStarted: 4 }
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.blocks.length, 1, 'now it is drifting')
  assert.equal(goals.blocks[0].reason.code, 'no-progress')
})

test('two jobs: the goal stays paused until the last one settles', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }, { id: 'j2', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)

  jobs.settle('j1')
  assert.deepEqual(goals.resumes, [], 'one job left is still something to wait for')
  assert.equal(goals.state.goal.phase, 'paused')

  jobs.settle('j2', 'killed')
  assert.equal(goals.resumes.length, 1, 'a killed job has settled like any other')
})

test('a goal a human already resumed is forgotten rather than resumed again', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.state.goal.phase, 'paused')

  goals.state.goal = { ...goals.state.goal, phase: 'active', activation: 'armed' } // the human hit resume
  jobs.settle('j1')
  assert.deepEqual(goals.resumes, [], 'the guard must not fight a human for the goal')
})

test('an unowned job is visible to every agent, so its settlement lifts any deferral', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)

  jobs.settle('j1')
  assert.equal(goals.resumes.length, 1, 'nothing is left to wait for, whoever started it')
})

test('without a jobs service the deferral is inert and the no-progress rule still works', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 2 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' }) // seeds the window
  for (const started of [4, 5]) {
    goals.state.goal = { ...goals.state.goal, roundsStarted: started }
    ctx.emit('agent/status', { agent, status: 'idle' })
  }
  assert.deepEqual(goals.pauses, [], 'there is nothing to wait for')
  assert.equal(goals.blocks.length, 1)
  assert.equal(goals.blocks[0].reason.code, 'no-progress')
})

test('a round that used a tool clears the streak', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 2 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' })
  goals.state.goal = { ...goals.state.goal, roundsStarted: 4 }
  ctx.emit('agent/status', { agent, status: 'idle' }) // round 1: nothing
  ctx.emit('session/event', agent.session, toolCallEvent())
  goals.state.goal = { ...goals.state.goal, roundsStarted: 5 }
  ctx.emit('agent/status', { agent, status: 'idle' }) // round 2: worked, streak resets
  goals.state.goal = { ...goals.state.goal, roundsStarted: 6 }
  ctx.emit('agent/status', { agent, status: 'idle' }) // round 3: nothing again

  assert.deepEqual(goals.blocks, [], 'one working round resets the count')
})

test('a tool call in a window with no admitted round does not carry over', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 1 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' })   // seeds
  ctx.emit('session/event', agent.session, toolCallEvent()) // the human's own turn
  goals.state.goal = { ...goals.state.goal, roundsStarted: 4 }
  ctx.emit('agent/status', { agent, status: 'idle' })

  assert.deepEqual(goals.blocks, [], 'the window is what matters, not a moving total')
})

test('a tool call for another session never counts toward this one', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 1 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' })
  ctx.emit('session/event', liveAgent('dsh-b').session, toolCallEvent())
  goals.state.goal = { ...goals.state.goal, roundsStarted: 4 }
  ctx.emit('agent/status', { agent, status: 'idle' })

  assert.equal(goals.blocks.length, 1, 'counters are per session')
})

test('a repeated quiescent edge with no new round accumulates nothing', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 2 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' })  // seeds
  goals.state.goal = { ...goals.state.goal, roundsStarted: 4 }
  ctx.emit('agent/status', { agent, status: 'idle' })  // round 1: produced nothing
  ctx.emit('agent/status', { agent, status: 'idle' })  // no round was admitted, twice over
  ctx.emit('agent/status', { agent, status: 'idle' })

  assert.deepEqual(goals.blocks, [], 'only an admitted round may be counted as a barren one')
})

test('the first sight of a goal seeds the window instead of judging it', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 40 }) })
  const agent = liveAgent('dsh-a')
  const { ctx } = await mount({ config: { maxBarrenRounds: 1 }, goals })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.deepEqual(goals.blocks, [], 'rounds that ran before the guard was mounted are not charged to it')

  goals.state.goal = { ...goals.state.goal, roundsStarted: 41 }
  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.blocks.length, 1)
})

test('a non-idle status is not a decision edge', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  for (const status of ['running', 'running', 'running']) ctx.emit('agent/status', { agent, status })
  assert.deepEqual(goals.pauses, [], 'a running turn is never cancelled or paused by this plugin')
})

test('dry-run logs the deferral and the stop it would write, and writes neither', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ config: { dryRun: true, maxBarrenRounds: 1 }, goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.deepEqual(goals.pauses, [], 'dry-run never touches the goal')
  assert.equal(goals.state.goal.phase, 'active', 'and the deferral it reported did not happen')
})

test('a refused pause or block is reported and does not take the session down', async () => {
  const paused = goalsService({ goal: view({ roundsStarted: 3 }), pauseThrows: true })
  const agentA = liveAgent('dsh-a')
  const jobsA = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx: ctxA } = await mount({ goals: paused, jobs: jobsA })
  ctxA.emit('agent/status', { agent: agentA, status: 'idle' })
  assert.deepEqual(paused.pauses, [])

  const blocked = goalsService({ goal: view({ roundsStarted: 9 }), blockThrows: true })
  const { ctx: ctxB } = await mount({ config: { maxBarrenRounds: 1 }, goals: blocked })
  const agentB = liveAgent('dsh-b')
  ctxB.emit('agent/status', { agent: agentB, status: 'idle' })
  blocked.state.goal = { ...blocked.state.goal, roundsStarted: 10 }
  ctxB.emit('agent/status', { agent: agentB, status: 'idle' })
  assert.deepEqual(blocked.blocks, [], 'a refusing goal service is contained, not escalated')
})

test('a session with no goal is ignored, and a failing goal read is contained', async () => {
  const none = goalsService({ goal: undefined })
  const { ctx: ctxA } = await mount({ config: { maxBarrenRounds: 1 }, goals: none })
  ctxA.emit('agent/status', { agent: liveAgent('dsh-a'), status: 'idle' })
  assert.deepEqual(none.blocks, [])

  const failing = goalsService({ goal: view(), getThrows: true })
  const { ctx: ctxB } = await mount({ config: { maxBarrenRounds: 1 }, goals: failing })
  ctxB.emit('agent/status', { agent: liveAgent('dsh-b'), status: 'idle' })
  assert.deepEqual(failing.blocks, [], 'a refusing read must not be turned into a stop attempt')
})

test('a disposed agent is forgotten', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }) })
  const agent = liveAgent('dsh-a')
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const { ctx } = await mount({ goals, jobs })

  ctx.emit('agent/status', { agent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)
  ctx.emit('agent/disposed', { agent })

  jobs.settle('j1')
  assert.deepEqual(goals.resumes, [], 'nothing is remembered about a disposed agent')

  // The session id can be reused: a fresh state seeds and decides on its own,
  // with no memory of the deferral that belonged to the previous agent.
  goals.state.goal = { ...goals.state.goal, phase: 'active', activation: 'armed' }
  jobs.state.jobs.push({ id: 'j2', status: 'running', owner: 'dsh-a' })
  ctx.emit('agent/status', { agent: liveAgent('dsh-a'), status: 'idle' })
  assert.equal(goals.pauses.length, 2, 'the fresh session is tracked from scratch')
})

// ------------------------------------------------------------ direct guard use

test('createProgressGuard can be driven directly, and reports what it observed', () => {
  const agent = liveAgent('dsh-a')
  const goals = goalsService({ goal: view({ roundsStarted: 7 }) })
  const jobs = jobsService({ jobs: [{ id: 'j1', status: 'running', owner: 'dsh-a' }] })
  const lines = []
  const ctx = {
    goals: goals.service,
    logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) },
  }
  const guard = createProgressGuard(ctx, {})
  guard.attachJobs(jobs.service)

  guard.observeToolCall('dsh-a')
  guard.observeToolCall('dsh-a')
  assert.deepEqual(guard.observed('dsh-a'), {
    lastRoundsStarted: undefined,
    toolCallsInWindow: 2,
    barrenStreak: 0,
    deferred: false,
    capped: false,
  }, 'an untouched session is empty, not guessed at')

  guard.evaluate(agent)
  assert.deepEqual(guard.observed('dsh-a'), {
    lastRoundsStarted: 7,
    toolCallsInWindow: 0,
    barrenStreak: 0,
    deferred: true,
    capped: false,
  }, 'goals.state.goal was left alone')
  assert.equal(goals.state.goal.phase, 'paused')
  assert.match(lines.join('\n'), /paused goal "g1"/)

  guard.forget(agent)
  assert.equal(guard.observed('dsh-a').deferred, false)
  assert.equal(guard.observed('dsh-a').barrenStreak, 0)
})

// ------------------------------------------------- the delegated-child dimension

test('isRunningChild counts exactly the running, delegated child of one parent', () => {
  const running = (header, id = 'dsh-c') => liveAgent(id, { status: 'running', header })
  assert.equal(isRunningChild(running(childHeader('dsh-a')), 'dsh-a'), true)
  assert.equal(isRunningChild(running(childHeader('dsh-a'), 'dsh-c'), 'dsh-a'), true)
  assert.equal(isRunningChild(liveAgent('dsh-c', { status: 'idle', header: childHeader('dsh-a') }), 'dsh-a'), false,
    'a continuable child stays resident between turns — residency is not work in flight')
  assert.equal(isRunningChild(running(childHeader('dsh-b')), 'dsh-a'), false,
    "another session's child is not this session's work")
  assert.equal(isRunningChild(running(forkHeader('dsh-a')), 'dsh-a'), false,
    'a fork records parentSession too, and a fork is a sibling rather than work to wait for')
  assert.equal(isRunningChild(running(undefined, 'dsh-a'), 'dsh-a'), false, 'a session is not its own child')
  assert.equal(isRunningChild(running(undefined), 'dsh-a'), false, 'no header, no lineage')
})

test('a goal is paused while a delegated child runs, and resumed when that child stops', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const { ctx } = await mount({ goals, agents: agentsService([parent, child]) })

  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(goals.pauses.length, 1, 'a running delegated child is the same reason to wait as a job')
  assert.equal(goals.state.goal.phase, 'paused')

  // The child's own quiescent edge is the release trigger, and it is the only
  // timely one: a continuable child keeps its residency epoch open across turns.
  child.status = 'idle'
  ctx.emit('agent/status', { agent: child, status: 'idle' })
  assert.equal(goals.resumes.length, 1, 'the child stopping running is what the parent was waiting for')
  assert.equal(goals.state.goal.phase, 'active')
})

test('a goal stays paused until the last of several children stops', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const first = liveAgent('dsh-c1', { status: 'running', header: childHeader('dsh-a') })
  const second = liveAgent('dsh-c2', { status: 'running', header: childHeader('dsh-a') })
  const { ctx } = await mount({ goals, agents: agentsService([parent, first, second]) })

  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)

  first.status = 'idle'
  ctx.emit('agent/status', { agent: first, status: 'idle' })
  assert.deepEqual(goals.resumes, [], 'one child left is still something to wait for')
  assert.equal(goals.state.goal.phase, 'paused')

  second.status = 'idle'
  ctx.emit('agent/status', { agent: second, status: 'idle' })
  assert.equal(goals.resumes.length, 1)
})

test('a disposed child is no longer work in flight', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const agents = agentsService([parent, child])
  const { ctx } = await mount({ goals, agents })

  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)

  agents.state.agents = [parent]
  ctx.emit('agent/disposed', { agent: child })
  assert.equal(goals.resumes.length, 1, 'work that no longer exists is not work to wait for')
})

test("a child's own deferral is judged on its own goal, not its parent's", async () => {
  const parentGoals = goalsService({ goal: view({ id: 'gp', roundsStarted: 3 }), owner: 'dsh-a' })
  const childGoals = goalsService({ goal: view({ id: 'gc', roundsStarted: 1 }), owner: 'dsh-c' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const grandchild = liveAgent('dsh-g', { status: 'running', header: childHeader('dsh-c') })
  const agents = agentsService([parent, child, grandchild])

  // One service, two owners: the goals stub dispatches on the live agent.
  const both = {
    service: {
      get: (agent) => parentGoals.service.get(agent) ?? childGoals.service.get(agent),
      pause: (agent, ref) => (agent.id === 'dsh-c' ? childGoals.service : parentGoals.service).pause(agent, ref),
      resume: (agent, ref) => (agent.id === 'dsh-c' ? childGoals.service : parentGoals.service).resume(agent, ref),
      block: (agent, ref, reason) => (agent.id === 'dsh-c' ? childGoals.service : parentGoals.service).block(agent, ref, reason),
    },
  }

  const { ctx } = await mount({ goals: both, agents })

  // The parent's own quiescent edge defers it on the child that is still
  // running. This must come first: the child's edge below is what releases it.
  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(parentGoals.pauses.length, 1, 'the parent waits for the child')
  assert.deepEqual(childGoals.pauses, [], 'and the child, still running, is not consulted yet')

  // One edge, two independent judgements: the child is evaluated against its
  // OWN goal (it has a running grandchild), and its own stop releases the
  // parent, whose work is now over.
  child.status = 'idle'
  ctx.emit('agent/status', { agent: child, status: 'idle' })
  assert.equal(childGoals.pauses.length, 1, 'the child waits for its own child')
  assert.equal(parentGoals.resumes.length, 1, 'and the child stopping frees the parent')
  assert.equal(parentGoals.state.goal.phase, 'active')
  assert.equal(childGoals.state.goal.phase, 'paused')

  grandchild.status = 'idle'
  ctx.emit('agent/status', { agent: grandchild, status: 'idle' })
  assert.equal(childGoals.resumes.length, 1, 'the grandchild stops, so the child may move again')
  assert.equal(parentGoals.resumes.length, 1, 'and the parent is not touched: it is not waiting on the grandchild')
})

test('without an agents service the child dimension is inert and the rest still works', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const { ctx } = await mount({ config: { maxBarrenRounds: 2 }, goals })

  ctx.emit('agent/status', { agent: parent, status: 'idle' }) // seeds the window
  for (const started of [4, 5]) {
    goals.state.goal = { ...goals.state.goal, roundsStarted: started }
    ctx.emit('agent/status', { agent: parent, status: 'idle' })
  }
  assert.deepEqual(goals.pauses, [], 'a child the guard cannot see is not work it waits for')
  assert.equal(goals.blocks.length, 1, 'and the no-progress dimension is untouched')

  ctx.emit('agent/status', { agent: child, status: 'idle' })
  assert.deepEqual(goals.resumes, [], 'a child edge has nothing to release when nothing was deferred')
})

test('the plugin touches only members the agents service actually publishes', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const agents = agentsService([parent, child])

  // Property reads are what a removed *method* looks like from the outside, so
  // the read itself is the only thing observable here. The registry publishes
  // `list()` and `get(id)`; this dimension needs the live list and nothing else.
  const touched = new Set()
  const watched = new Proxy(agents.service, {
    get(target, prop, receiver) {
      if (typeof prop === 'string') touched.add(prop)
      return Reflect.get(target, prop, receiver)
    },
  })

  const ctx = new Context()
  ctx.provide('goals', goals.service)
  ctx.provide('agents', watched)
  await ctx.plugin({ name, inject, apply, Config }, {})
  ctx.emit('agent/status', { agent: parent, status: 'idle' })

  assert.deepEqual([...touched].sort(), ['list'])
  assert.equal(goals.pauses.length, 1)
})

// ------------------------------------------------------------- the deferral cap

test('maxDeferMs lifts a deferral nothing else can lift, and stops deferring until the work drains', () => {
  const agent = liveAgent('dsh-a')
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const agents = agentsService([agent, child])
  const sched = scheduler()
  const lines = []
  const guard = createProgressGuard(
    { goals: goals.service, logger: { info: (line) => lines.push(line), warn: (line) => lines.push(line) }, schedule: sched.schedule },
    { maxDeferMs: 60000, maxBarrenRounds: 1 },
  )
  guard.attachAgents(agents.service)

  guard.evaluate(agent)
  assert.equal(goals.pauses.length, 1)
  assert.equal(sched.armed.length, 1, 'the pause and its deadline are written together')
  assert.equal(sched.armed[0].delayMs, 60000)

  sched.fireAll() // the deadline elapses; the child is still running
  assert.equal(goals.resumes.length, 1, 'a deadline that never fires is not a deadline')
  assert.equal(guard.observed('dsh-a').capped, true)
  assert.equal(sched.armed[0].cancelled, true, 'lifting the deferral disarms its own deadline')

  // The rounds from here are admitted by the guard's own deadline, so they are
  // not drift, and they must not be deferred again either — re-pausing would
  // withdraw the very round the deadline just released.
  for (const started of [4, 5, 6]) {
    goals.state.goal = { ...goals.state.goal, roundsStarted: started }
    guard.evaluate(agent)
  }
  assert.deepEqual(goals.blocks, [], 'charging these rounds would stop a goal whose work is still running')
  assert.equal(goals.pauses.length, 1)

  // The work finally drains, and the cap goes with it.
  agents.state.agents = [agent]
  guard.evaluate(agent)
  assert.equal(guard.observed('dsh-a').capped, false, 'the cap lasts only as long as the work it was holding for')

  goals.state.goal = { ...goals.state.goal, roundsStarted: 7 }
  guard.evaluate(agent)
  assert.equal(goals.blocks.length, 1, 'once the work is gone, the ordinary rules are back')
})

test('an unset maxDeferMs arms nothing: the deferral is held for as long as its work is observable', () => {
  const agent = liveAgent('dsh-a')
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const sched = scheduler()
  const guard = createProgressGuard(
    { goals: goals.service, logger: { info: () => {}, warn: () => {} }, schedule: sched.schedule },
    {},
  )
  guard.attachAgents(agentsService([agent, child]).service)

  guard.evaluate(agent)
  assert.equal(goals.pauses.length, 1)
  assert.deepEqual(sched.armed, [], 'the default is the pre-0.3.0 behaviour: no clock, no cap')
})

test('without a scheduler a configured cap degrades to the unbounded deferral rather than throwing', () => {
  const agent = liveAgent('dsh-a')
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const guard = createProgressGuard({ goals: goals.service, logger: { info: () => {}, warn: () => {} } }, { maxDeferMs: 60000 })
  guard.attachAgents(agentsService([agent, child]).service)

  guard.evaluate(agent)
  assert.equal(goals.pauses.length, 1, 'the guard is harness-free, so a clock is not something it can require')
  assert.equal(goals.resumes.length, 0)
})

test('a settlement that arrives before the deadline lifts without capping', () => {
  const agent = liveAgent('dsh-a')
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const agents = agentsService([agent, child])
  const sched = scheduler()
  const guard = createProgressGuard(
    { goals: goals.service, logger: { info: () => {}, warn: () => {} }, schedule: sched.schedule },
    { maxDeferMs: 60000 },
  )
  guard.attachAgents(agents.service)

  guard.evaluate(agent)
  agents.state.agents = [agent]
  guard.childSettled(child)
  assert.equal(goals.resumes.length, 1, 'the work finished on its own, well inside the deadline')
  assert.equal(guard.observed('dsh-a').capped, false, 'only a deadline may cap the deferral')
  assert.equal(sched.armed[0].cancelled, true, 'and the deadline it no longer needs is disarmed')

  sched.fireAll()
  assert.equal(goals.resumes.length, 1, 'a disarmed deadline cannot act twice')
})

test('the mounted guard arms its deadline on a real timer', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const { ctx } = await mount({ config: { maxDeferMs: 20 }, goals, agents: agentsService([parent, child]) })

  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)
  assert.deepEqual(goals.resumes, [], 'nothing has elapsed yet')

  await new Promise((resolve) => { setTimeout(resolve, 80) })
  assert.equal(goals.resumes.length, 1, 'the mount wires the scheduler, so the deadline really is a timer')
})

test('a disposed deferred agent leaves no armed deadline behind', async () => {
  const goals = goalsService({ goal: view({ roundsStarted: 3 }), owner: 'dsh-a' })
  const parent = liveAgent('dsh-a')
  const child = liveAgent('dsh-c', { status: 'running', header: childHeader('dsh-a') })
  const { ctx } = await mount({ config: { maxDeferMs: 20 }, goals, agents: agentsService([parent, child]) })

  ctx.emit('agent/status', { agent: parent, status: 'idle' })
  assert.equal(goals.pauses.length, 1)
  ctx.emit('agent/disposed', { agent: parent })

  await new Promise((resolve) => { setTimeout(resolve, 80) })
  assert.deepEqual(goals.resumes, [], 'a timer for a session nothing remembers must not fire at it')
})
