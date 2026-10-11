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
  mountLine,
  name,
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
 * @param options - the current goal view and optional forced failures.
 * @returns the service, the calls it accepted, and the mutable goal holder.
 */
function goalsService({ goal = undefined, getThrows = false, pauseThrows = false, blockThrows = false } = {}) {
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

/** A minimal agent stand-in: the plugin only ever reads `agent.id` and `agent.session`. */
function liveAgent(id) {
  return { id, session: { id } }
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
 * `jobs` is provided only when a test passes one, which is also how the
 * "composition without background jobs" case is exercised.
 *
 * @param options - plugin config and the stub services to provide.
 * @returns the mounted context and the stubs.
 */
async function mount({ config = {}, goals, jobs } = {}) {
  const ctx = new Context()
  ctx.provide('goals', goals.service)
  if (jobs !== undefined) ctx.provide('jobs', jobs.service)
  await ctx.plugin({ name, inject, apply, Config }, config)
  return { ctx, goals, jobs }
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

test('deferDecision: only an armed, active goal with an observable pending job defers', () => {
  const armed = { deferWhileJobsPending: true, phase: 'active', activation: 'armed', unsettledJobs: 1 }
  assert.equal(deferDecision(armed), 'defer')
  assert.equal(deferDecision({ ...armed, deferWhileJobsPending: false }), 'none', 'the dimension can be switched off')
  assert.equal(deferDecision({ ...armed, phase: 'paused' }), 'none', 'a paused goal has nothing to defer')
  assert.equal(deferDecision({ ...armed, phase: 'blocked' }), 'none')
  assert.equal(deferDecision({ ...armed, activation: 'disarmed' }), 'none', 'a disarmed goal is not taking rounds')
  assert.equal(deferDecision({ ...armed, unsettledJobs: 0 }), 'none')
  assert.equal(deferDecision({ ...armed, unsettledJobs: undefined }), 'none',
    'an unobservable job count must never defer — that is the composition without a jobs service')
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
  assert.equal(resumeDecision({ phase: 'paused', unsettledJobs: 0 }), 'resume')
  assert.equal(resumeDecision({ phase: 'paused', unsettledJobs: 2 }), 'none')
  assert.equal(resumeDecision({ phase: 'active', unsettledJobs: 0 }), 'forget', 'a human already resumed it')
  assert.equal(resumeDecision({ phase: 'blocked', unsettledJobs: 0 }), 'forget')
  assert.equal(resumeDecision({ phase: 'absent', unsettledJobs: 0 }), 'forget', 'the goal is gone')
  assert.equal(resumeDecision({ phase: 'paused', unsettledJobs: undefined }), 'resume',
    'an unobservable job count resumes: a deferral this plugin cannot lift would strand the goal')
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
  assert.match(mountLine({}), /deferWhileJobsPending=on, maxBarrenRounds=unset/)
  assert.doesNotMatch(mountLine({}), /inert/, 'the default configuration does enforce the deferral dimension')
  assert.match(mountLine({ deferWhileJobsPending: false, maxBarrenRounds: undefined }), /inert/)
  assert.match(mountLine({ maxBarrenRounds: 3, dryRun: true }), /maxBarrenRounds=3 \(dry-run\)/)
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
  }, 'an untouched session is empty, not guessed at')

  guard.evaluate(agent)
  assert.deepEqual(guard.observed('dsh-a'), {
    lastRoundsStarted: 7,
    toolCallsInWindow: 0,
    barrenStreak: 0,
    deferred: true,
  }, 'goals.state.goal was left alone')
  assert.equal(goals.state.goal.phase, 'paused')
  assert.match(lines.join('\n'), /paused goal "g1"/)

  guard.forget(agent)
  assert.equal(guard.observed('dsh-a').deferred, false)
  assert.equal(guard.observed('dsh-a').barrenStreak, 0)
})
