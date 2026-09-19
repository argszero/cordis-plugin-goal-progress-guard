/**
 * Stop a dsh goal from spinning, and let it wait for work that is already running.
 *
 * A goal (`@deepseek-ai/dsh-goal` plus `@deepseek-ai/dsh-goal-round-driver`)
 * keeps a session working after the human's turn ends: every time the session
 * goes quiescent the driver queues one more round, for as long as the goal's
 * phase is `active` and its live activation is `armed`. The driver has exactly
 * one reason to stop — the goal's own `maxGoalRounds` — and no notion of
 * whether a round accomplished anything.
 *
 * `idle` means only "no turn is running". An agent that has just started a
 * background job and ended its turn to wait for it is indistinguishable, at
 * that signal, from an agent that is finished. The result is the two failure
 * modes reported in discussion #7198 and its predecessors #1831 / #4664:
 *
 * - **forced speech**: the agent cannot wait for anything, so every round must
 *   produce output even when there is nothing to say — and, per #4664, it
 *   fabricates a sense of elapsed time ("~15/20/25 min in") which later rounds
 *   then read as fact;
 * - **drift**: #1831 recorded 160 near-identical rounds before a human stopped
 *   it.
 *
 * This plugin adds the two missing judgements, from outside the driver, with no
 * core change:
 *
 * 1. **Pending work defers the loop** (`deferWhileJobsPending`, default on).
 *    At the quiescent edge, if the agent still owns an unsettled job, the goal
 *    is *paused* rather than allowed to take another round; when the last job
 *    settles, the goal is *resumed*. The rounds in between are the ones the
 *    agent would otherwise have spent talking to itself while waiting.
 * 2. **A round that produced nothing is counted** (`maxBarrenRounds`).
 *    Consecutive settled rounds with no `tool/call` in the window stop the goal
 *    with a durable `no-progress` reason. This is the cheapest form of the
 *    "no progress" rule, and it needs no extra model call — which is the point
 *    Codex's goal cookbook makes when it suppresses a continuation turn that
 *    made no tool call.
 *
 * The two are deliberately separable: an evaluation planner is a different
 * question, and neither dimension here depends on one.
 *
 * Honest boundaries, all of them:
 *
 * - **Stop and defer are different operations, and this plugin uses both.**
 *   `pause` (defer) keeps the goal alive and resumable; `block` (stop) is
 *   terminal until a human resumes it and carries a durable reason. A stall in
 *   a live loop is a deferral; only a run of barren rounds is a verdict.
 * - **The deferral is a snapshot, not a subscription.** It is re-evaluated at
 *   each quiescent edge and on each job settlement. A job started by something
 *   other than this agent's turn (another session's work, a human's shell) does
 *   not defer anything.
 * - **`stopping` counts as unsettled.** A job being killed has not settled; it
 *   still reports `finishedAt === undefined`.
 * - **No jobs service, no deferral.** The jobs service is injected optionally;
 *   with no `jobs` in the composition the deferral dimension is inert and the
 *   no-progress dimension still works.
 * - **The no-progress window is the span between two quiescent edges**, and a
 *   window in which no round was admitted (because the human was driving) does
 *   not count toward the streak. Tool calls are read from the durable session
 *   log, so the rule is replayable rather than live-only.
 * - **It does not interrupt work in flight.** Both decisions are taken when the
 *   agent is quiescent. A running turn is never cancelled by this plugin.
 * - **Waiting for something that is not a job** (an approval, a subagent that
 *   reports through another channel) is not covered; the same pause/resume
 *   shape extends to it, with a different trigger.
 *
 * @packageDocumentation
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'

/** Plugin name, as the loader registers it. */
export const name = 'goal-progress-guard'

/**
 * The services this plugin reads. Only the goal service is required: the jobs
 * service is injected optionally in {@link apply}, so a composition without
 * background jobs still mounts this plugin and still gets the no-progress rule.
 */
export const inject = ['goals']

/** Deployment policy for goal-round progress. */
export interface Config {
  /**
   * Consecutive settled rounds with no `tool/call` that stop the goal. Unset
   * means the dimension is not enforced.
   */
  maxBarrenRounds?: number
  /**
   * Pause an active goal while the agent still owns an unsettled job, and
   * resume it when the last one settles. Defaults to `true`; set `false` to
   * keep only the no-progress dimension.
   */
  deferWhileJobsPending?: boolean
  /** Log the stop or deferral this policy would perform instead of performing it. */
  dryRun?: boolean
}

/** Schemastery config for the progress policy. */
export const Config: z<Config> = z.object({
  maxBarrenRounds: z.number().step(1).min(1).required(false),
  deferWhileJobsPending: z.boolean().default(true),
  dryRun: z.boolean().default(false),
})

/** A window between two quiescent edges, judged as one admitted round. */
export interface RoundWindow {
  /** Rounds already counted as having produced nothing. */
  readonly barrenStreak: number
  /** Whether a round was admitted in this window. */
  readonly roundSettled: boolean
  /** `tool/call` events observed inside the window. */
  readonly toolCalls: number
}

/**
 * Advance the barren-round streak by one window.
 *
 * Pure: the whole counting rule is here, so it can be tested exhaustively
 * without a harness. A window the human drove (no round admitted) is not
 * evidence of drift and resets the streak — the human is supervising.
 *
 * @param window - the window just closed.
 * @returns the streak after the window.
 */
export function advanceBarrenStreak(window: RoundWindow): number {
  if (!window.roundSettled) return 0
  return window.toolCalls === 0 ? window.barrenStreak + 1 : 0
}

/** The quantities the deferral decision is taken from. */
export interface DeferObservation {
  /** Whether the deferral dimension is enabled for this deployment. */
  readonly deferWhileJobsPending: boolean
  /** Durable goal phase. */
  readonly phase: string
  /** Live goal activation. */
  readonly activation: string
  /** Unsettled jobs owned by this agent, or `undefined` when not observable. */
  readonly unsettledJobs: number | undefined
}

/**
 * Decide whether the goal should be paused to wait for work already running.
 *
 * Only an `active`, `armed` goal is deferred — a paused or blocked goal has
 * nothing to defer — and an unobservable job count never defers, so a
 * composition without the jobs service behaves exactly as it did before.
 *
 * @param observed - the quantities read for one agent.
 * @returns `defer` when the goal should wait.
 */
export function deferDecision(observed: DeferObservation): 'defer' | 'none' {
  if (!observed.deferWhileJobsPending) return 'none'
  if (observed.phase !== 'active' || observed.activation !== 'armed') return 'none'
  if (observed.unsettledJobs === undefined || observed.unsettledJobs === 0) return 'none'
  return 'defer'
}

/** The quantities the no-progress decision is taken from. */
export interface BlockObservation {
  /** Configured streak that stops the goal, or `undefined` when unenforced. */
  readonly maxBarrenRounds: number | undefined
  /** Streak after the window just closed. */
  readonly barrenStreak: number
  /** Durable goal phase. */
  readonly phase: string
}

/**
 * Decide whether the goal has stopped making progress.
 *
 * Pure. `block` requires an `active` goal, so a goal already paused for pending
 * work is left alone rather than converted into a stop.
 *
 * @param observed - the quantities read for one agent.
 * @returns the durable reason to stop the goal, or `undefined` to continue.
 */
export function blockDecision(observed: BlockObservation): { code: string; message: string } | undefined {
  if (observed.maxBarrenRounds === undefined) return undefined
  if (observed.phase !== 'active') return undefined
  if (observed.barrenStreak < observed.maxBarrenRounds) return undefined
  return {
    code: 'no-progress',
    message: `Goal stopped: ${observed.barrenStreak} consecutive rounds completed without a single tool call. `
      + 'It is repeating itself rather than working; resume it when there is something new to do.',
  }
}

/** What to do about a goal this plugin paused earlier. */
export type ResumeDecision = 'resume' | 'forget' | 'none'

/** The quantities the resume decision is taken from. */
export interface ResumeObservation {
  /** Durable goal phase. */
  readonly phase: string
  /** Unsettled jobs owned by this agent, or `undefined` when not observable. */
  readonly unsettledJobs: number | undefined
}

/**
 * Decide whether a goal this plugin paused should be resumed.
 *
 * Two asymmetries are deliberate:
 *
 * - a goal that is no longer `paused` was moved by someone else (a human, or
 *   the round-limit block), so the record is simply forgotten rather than
 *   fought over;
 * - an unobservable job count resumes rather than stays paused. Staying paused
 *   is the failure that strands the goal — the plugin's own pause must always
 *   be releasable, and a deferral that cannot be lifted is worse than one that
 *   lifts early.
 *
 * @param observed - the quantities read for one agent.
 * @returns `resume`, `forget`, or `none`.
 */
export function resumeDecision(observed: ResumeObservation): ResumeDecision {
  if (observed.phase !== 'paused') return 'forget'
  if ((observed.unsettledJobs ?? 0) > 0) return 'none'
  return 'resume'
}

/** Whether a job has not reached a terminal state. */
export function isUnsettled(job: { readonly status?: unknown }): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Whether one session event is a durable tool call.
 *
 * Structural, and deliberately not a value import: `tool/call` is a declared
 * event type of the session package, and this plugin only reads it.
 */
export function isToolCallEvent(event: unknown): boolean {
  return (event as { type?: unknown } | undefined)?.type === 'tool/call'
}

/** The subset of `GoalView` and the goal service this plugin programs against. */
export interface GoalRefLike {
  readonly id: string
  readonly revision: number
}

/** The durable goal view this plugin reads. */
export interface GoalViewLike extends GoalRefLike {
  readonly phase: string
  readonly activation: string
  readonly roundsStarted: number
}

/** The goal service surface this plugin uses, all of it documented and public. */
export interface GoalsLike {
  get(agent: unknown): GoalViewLike | undefined
  pause(agent: unknown, ref: GoalRefLike): GoalViewLike
  resume(agent: unknown, ref: GoalRefLike): GoalViewLike
  block(agent: unknown, ref: GoalRefLike, reason: { code: string; message: string }): GoalViewLike
}

/** One job as `JobsService.list` reports it. */
export interface JobLike {
  readonly status: string
}

/** The jobs service surface this plugin uses. */
export interface JobsLike {
  list(caller?: unknown): JobLike[]
}

/** A disposable registration, as `onJobDone` returns. */
export type Disposer = () => void

/** The jobs service plus its settlement hook. */
export interface JobSource extends JobsLike {
  onJobDone(listener: (snapshot: unknown, owner: unknown) => void): Disposer
}

/**
 * The ambient surface the guard needs, injected so it can be driven in tests.
 *
 * The jobs service is deliberately *not* read from here: reading a service that
 * was not declared in `inject` throws, and the jobs service is optional by
 * design, so it is installed through {@link ProgressGuard.attachJobs} instead.
 */
export interface GuardContext {
  readonly goals: GoalsLike
  readonly logger: { info(message: string): void; warn(message: string): void }
}

/** What the guard currently believes about one session. */
export interface ObservedProgress {
  /** Durable rounds counted at the last quiescent edge, once seen. */
  readonly lastRoundsStarted: number | undefined
  /** `tool/call` events counted since that edge. */
  readonly toolCallsInWindow: number
  /** Consecutive settled rounds that produced nothing. */
  readonly barrenStreak: number
  /** Whether this plugin is currently holding the goal paused. */
  readonly deferred: boolean
}

/** The progress guard, usable without a harness. */
export interface ProgressGuard {
  /** Count one durable tool call for a session. */
  observeToolCall(sessionId: string): void
  /** Take both decisions for an agent that has just gone quiescent. */
  evaluate(agent: unknown): void
  /** Reconsider a deferred goal after a job settled. */
  jobSettled(owner: unknown): void
  /** Drop everything remembered about one agent. */
  forget(agent: unknown): void
  /** Install the optional jobs service once it becomes available. */
  attachJobs(jobs: JobSource): void
  /** What the guard believes about one session, for tests and reporting. */
  observed(sessionId: string): ObservedProgress
}

/** Per-session bookkeeping. */
interface Tracked {
  lastRoundsStarted: number | undefined
  toolCallsInWindow: number
  barrenStreak: number
  deferred: { agent: unknown; goalId: string } | undefined
}

/** Human-readable unexpected values for logs. */
function renderThrown(value: unknown): string {
  return value instanceof Error ? value.message : String(value)
}

/** One agent's session, or `undefined` when the shape is not the expected one. */
function sessionIdOf(agent: unknown): string | undefined {
  const session = (agent as { session?: { id?: unknown } } | undefined)?.session
  const id = session?.id
  return typeof id === 'string' ? id : undefined
}

/**
 * Build the guard.
 *
 * Everything that decides runs in `evaluate`; everything that observes feeds it.
 * Both service reads are wrapped, so a goal service that refuses a read or a
 * jobs service that throws degrades this plugin to a no-op for that edge rather
 * than taking the session down.
 *
 * @param ctx - the goal service, the optional jobs service, and a logger.
 * @param config - the resolved deployment policy.
 * @returns the guard.
 */
export function createProgressGuard(ctx: GuardContext, config: Config): ProgressGuard {
  const states = new Map<string, Tracked>()

  /**
   * The jobs service, once installed. Not read from `ctx`: this plugin does not
   * require the service, and an undeclared read would throw at mount.
   */
  let jobs: JobSource | undefined

  const deferEnabled = config.deferWhileJobsPending !== false
  const maxBarrenRounds = config.maxBarrenRounds
  const dryRun = config.dryRun === true

  function stateOf(sessionId: string): Tracked {
    const existing = states.get(sessionId)
    if (existing !== undefined) return existing
    const fresh: Tracked = {
      lastRoundsStarted: undefined,
      toolCallsInWindow: 0,
      barrenStreak: 0,
      deferred: undefined,
    }
    states.set(sessionId, fresh)
    return fresh
  }

  /** One agent's goal view, or `undefined` when there is none or the read fails. */
  function readGoal(agent: unknown): GoalViewLike | undefined {
    try {
      return ctx.goals.get(agent)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-progress-guard: could not read the current goal: ${renderThrown(error)}`)
      return undefined
    }
  }

  /** Unsettled jobs this agent owns, or `undefined` when not observable. */
  function unsettledJobs(agent: unknown): number | undefined {
    if (jobs === undefined) return undefined
    try {
      return jobs.list(agent).filter(isUnsettled).length
    } catch (error: unknown) {
      ctx.logger.warn(`goal-progress-guard: could not read background jobs: ${renderThrown(error)}`)
      return undefined
    }
  }

  const refOf = (goal: GoalViewLike): GoalRefLike => ({ id: goal.id, revision: goal.revision })

  function observeToolCall(sessionId: string): void {
    stateOf(sessionId).toolCallsInWindow += 1
  }

  function evaluate(agent: unknown): void {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const goal = readGoal(agent)
    if (goal === undefined) {
      states.delete(sessionId)
      return
    }
    const state = stateOf(sessionId)

    // 1. Work already running outranks another round. Taken before the streak
    //    bookkeeping: a round that ended in order to wait was not barren, so a
    //    deferral must not advance the streak.
    if (deferDecision({
      deferWhileJobsPending: deferEnabled,
      phase: goal.phase,
      activation: goal.activation,
      unsettledJobs: unsettledJobs(agent),
    }) === 'defer') {
      if (dryRun) ctx.logger.info(`goal-progress-guard: would pause goal "${goal.id}" while its background jobs run (dry-run)`)
      else if (pauseGoal(agent, goal)) state.deferred = { agent, goalId: goal.id }
      state.barrenStreak = 0
      state.lastRoundsStarted = goal.roundsStarted
      state.toolCallsInWindow = 0
      return
    }

    // 2. A window is only judged once a previous edge defines it: on first
    //    sight there is no window, and guessing one would charge the goal for
    //    rounds that ran before this plugin was mounted.
    if (state.lastRoundsStarted === undefined) {
      state.lastRoundsStarted = goal.roundsStarted
      state.toolCallsInWindow = 0
      return
    }

    state.barrenStreak = advanceBarrenStreak({
      barrenStreak: state.barrenStreak,
      roundSettled: goal.roundsStarted > state.lastRoundsStarted,
      toolCalls: state.toolCallsInWindow,
    })
    state.lastRoundsStarted = goal.roundsStarted
    state.toolCallsInWindow = 0

    const reason = blockDecision({ maxBarrenRounds, barrenStreak: state.barrenStreak, phase: goal.phase })
    if (reason === undefined) return
    if (dryRun) {
      ctx.logger.info(`goal-progress-guard: would stop goal "${goal.id}" with "${reason.code}" (dry-run)`)
      return
    }
    try {
      ctx.goals.block(agent, refOf(goal), reason)
      ctx.logger.info(`goal-progress-guard: stopped goal "${goal.id}" with "${reason.code}"`)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-progress-guard: could not stop goal "${goal.id}": ${renderThrown(error)}`)
    }
  }

  /** Pause one goal, reporting whether the pause was actually written. */
  function pauseGoal(agent: unknown, goal: GoalViewLike): boolean {
    try {
      ctx.goals.pause(agent, refOf(goal))
      ctx.logger.info(`goal-progress-guard: paused goal "${goal.id}" while its background jobs run`)
      return true
    } catch (error: unknown) {
      ctx.logger.warn(`goal-progress-guard: could not pause goal "${goal.id}": ${renderThrown(error)}`)
      return false
    }
  }

  /** Reconsider one agent's deferral, whoever triggered the settlement. */
  function release(agent: unknown): void {
    const sessionId = sessionIdOf(agent)
    if (sessionId === undefined) return
    const state = states.get(sessionId)
    if (state?.deferred === undefined) return
    const goal = readGoal(agent)
    const decision = resumeDecision({
      phase: goal?.phase ?? 'absent',
      unsettledJobs: unsettledJobs(agent),
    })
    if (decision === 'none') return
    state.deferred = undefined
    if (decision === 'forget' || goal === undefined) return
    if (dryRun) {
      ctx.logger.info(`goal-progress-guard: would resume goal "${goal.id}" after its jobs settled (dry-run)`)
      return
    }
    try {
      ctx.goals.resume(agent, refOf(goal))
      ctx.logger.info(`goal-progress-guard: resumed goal "${goal.id}" after its jobs settled`)
    } catch (error: unknown) {
      ctx.logger.warn(`goal-progress-guard: could not resume goal "${goal.id}": ${renderThrown(error)}`)
    }
    state.lastRoundsStarted = goal.roundsStarted
    state.toolCallsInWindow = 0
  }

  function jobSettled(owner: unknown): void {
    if (sessionIdOf(owner) !== undefined) {
      release(owner)
      return
    }
    // An unowned job is visible to every agent, so it can lift any deferral.
    for (const state of [...states.values()]) {
      if (state.deferred !== undefined) release(state.deferred.agent)
    }
  }

  function forget(agent: unknown): void {
    const sessionId = sessionIdOf(agent)
    if (sessionId !== undefined) states.delete(sessionId)
  }

  /** Install the jobs service once it becomes available. */
  function attachJobs(source: JobSource): void {
    jobs = source
  }

  function observed(sessionId: string): ObservedProgress {
    const state = states.get(sessionId)
    return {
      lastRoundsStarted: state?.lastRoundsStarted,
      toolCallsInWindow: state?.toolCallsInWindow ?? 0,
      barrenStreak: state?.barrenStreak ?? 0,
      deferred: state?.deferred !== undefined,
    }
  }

  return { observeToolCall, evaluate, jobSettled, forget, attachJobs, observed }
}

/**
 * One line stating what the guard understood, logged at mount.
 *
 * A policy nobody can read back is a policy nobody can trust; this makes the
 * effective configuration visible in the same place every other plugin's is.
 *
 * @param config - the resolved deployment policy.
 * @returns one line, prefixed with the plugin name.
 */
export function mountLine(config: Config): string {
  const defer = config.deferWhileJobsPending !== false ? 'on' : 'off'
  const barren = config.maxBarrenRounds === undefined ? 'unset' : String(config.maxBarrenRounds)
  return `goal-progress-guard: deferWhileJobsPending=${defer}, maxBarrenRounds=${barren}`
    + `${config.dryRun === true ? ' (dry-run)' : ''}`
    + `${config.deferWhileJobsPending === false && config.maxBarrenRounds === undefined ? ' — the guard is inert' : ''}`
}

/**
 * `ctx.on` for events the *harness* declares.
 *
 * `agent/status`, `agent/disposed` and `session/event` are declared by the
 * harness packages through `declare module '@deepseek-ai/cordis' { interface
 * Events { … } }`. Re-declaring them here would merge a second signature for
 * the same property into every consumer's type space, and TypeScript rejects
 * two declarations of one property that disagree — so this package reads the
 * three event names it uses through one narrow cast, and keeps the shapes in
 * {@link apply}'s callback signatures where a reader can see them.
 */
type HarnessEventOn = (
  event: string,
  listener: (...args: any[]) => void,
  options?: { prepend?: boolean },
) => void

/**
 * Mount the guard.
 *
 * Three listeners and one optional injection:
 *
 * - `session/event` counts durable `tool/call` events, which is the evidence
 *   the no-progress rule is decided from;
 * - `agent/status` at `idle` is the decision edge, **prepended** so the
 *   deferral lands before the goal-round driver's own listener can queue the
 *   next round. That ordering is not cosmetic: when the driver has no pending
 *   durability checkpoint its listener reaches `agent.followup` synchronously
 *   within the same emit, so a pause registered after it would arrive one round
 *   too late, every round;
 * - `agent/disposed` releases the bookkeeping;
 * - `jobs` is injected optionally, so the no-progress dimension works in a
 *   composition with no background jobs, and the deferral dimension appears
 *   only where waiting is actually possible.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved deployment policy.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const guard = createProgressGuard(ctx as unknown as GuardContext, config)
  ctx.logger.info(mountLine(config))

  const on = ctx.on as unknown as HarnessEventOn

  // Evidence: a durable tool call in the window between two quiescent edges.
  on('session/event', (session: { id?: unknown }, event: unknown) => {
    if (!isToolCallEvent(event)) return
    if (typeof session?.id === 'string') guard.observeToolCall(session.id)
  })

  // Decision edge, ordered ahead of the driver's own listener.
  on('agent/status', (payload: { agent: unknown; status?: unknown }) => {
    if (payload?.status !== 'idle') return
    guard.evaluate(payload.agent)
  }, { prepend: true })

  on('agent/disposed', (payload: { agent: unknown }) => { guard.forget(payload.agent) })

  // The jobs service is optional by design: a composition without it keeps the
  // no-progress dimension and leaves the deferral dimension inert.
  ctx.inject(['jobs'], (jobsCtx) => {
    const jobs = (jobsCtx as unknown as { jobs: JobSource }).jobs
    guard.attachJobs(jobs)
    jobsCtx.effect(() => jobs.onJobDone((_snapshot: unknown, owner: unknown) => { guard.jobSettled(owner) }))
  })
}
