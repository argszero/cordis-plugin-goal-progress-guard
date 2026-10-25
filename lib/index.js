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
 * This plugin adds the missing judgements, from outside the driver, with no
 * core change:
 *
 * 1. **Pending work defers the loop** (`deferWhileJobsPending` and
 *    `deferWhileSubagentsPending`, both default on). At the quiescent edge, if
 *    the agent still owns an unsettled job, or still has a delegated child
 *    running, the goal is *paused* rather than allowed to take another round;
 *    when the last of them finishes, the goal is *resumed*. The rounds in
 *    between are the ones the agent would otherwise have spent talking to
 *    itself while waiting. Discussion #9607 is the delegated-child half: an
 *    orchestrator whose only outstanding work is a running subagent looks
 *    exactly like a finished agent at the `idle` signal.
 * 2. **A round that produced nothing is counted** (`maxBarrenRounds`).
 *    Consecutive settled rounds with no `tool/call` in the window stop the goal
 *    with a durable `no-progress` reason. This is the cheapest form of the
 *    "no progress" rule, and it needs no extra model call — which is the point
 *    Codex's goal cookbook makes when it suppresses a continuation turn that
 *    made no tool call.
 * 3. **A deferral has a deadline** (`maxDeferMs`, unset by default). A pause
 *    that nothing can lift is the one outcome worse than an early round, so
 *    when a deadline is configured a deferral that is still held at that
 *    deadline is lifted, the round is admitted, and the guard stops deferring
 *    that goal until its pending set drains. Without it, work that never
 *    finishes — a job whose producer hung, a child stuck mid-turn — holds the
 *    goal paused indefinitely.
 *
 * The three are deliberately separable: an evaluation planner is a different
 * question, and no dimension here depends on another.
 *
 * Honest boundaries, all of them:
 *
 * - **Stop and defer are different operations, and this plugin uses both.**
 *   `pause` (defer) keeps the goal alive and resumable; `block` (stop) is
 *   terminal until a human resumes it and carries a durable reason. A stall in
 *   a live loop is a deferral; only a run of barren rounds is a verdict.
 * - **The deferral is a snapshot, not a subscription.** It is re-evaluated at
 *   each quiescent edge, at each job settlement, when a delegated child stops
 *   running, and when one is disposed. A job started by something other
 *   than this agent's turn (another session's work, a human's shell) does not
 *   defer anything.
 * - **`stopping` counts as unsettled.** A job being killed has not settled; it
 *   still reports `finishedAt === undefined`.
 * - **No jobs service, no job deferral; no agents registry, no child
 *   deferral.** Both services are injected optionally; with neither in the
 *   composition the deferral dimension is inert and the no-progress dimension
 *   still works.
 * - **A delegated child counts while it is *running*.** The count is a live
 *   read of the agent registry (`agents.list()`), filtered to entries whose
 *   durable session header names this session as parent and whose `origin` is
 *   `subagent` — so a child that is resident but between turns does not hold
 *   the goal, and a forked session is not mistaken for delegated work. A child
 *   a provider runs **out of process** has no live `Agent` here at all, so it
 *   cannot be counted; the dimension is inert for it and rounds are admitted
 *   as they were before this dimension existed.
 * - **The no-progress window is the span between two quiescent edges**, and a
 *   window in which no round was admitted (because the human was driving) does
 *   not count toward the streak. Tool calls are read from the durable session
 *   log, so the rule is replayable rather than live-only.
 * - **A round admitted after a capped deferral is not judged.** While the cap
 *   has lifted and the work is still pending, the guard neither defers nor
 *   counts a barren round: the round was admitted by the guard's own deadline,
 *   not chosen by a drifting loop, and charging drift to it would stop a goal
 *   whose work is demonstrably still running. The effect of setting both
 *   `maxDeferMs` and `maxBarrenRounds` is therefore that the streak is paused
 *   for as long as the cap is in force — set `maxBarrenRounds` as if the cap
 *   were absent.
 * - **It does not interrupt work in flight.** Every decision is taken when an
 *   agent is quiescent. A running turn is never cancelled by this plugin.
 * - **Waiting for something that is neither a job nor a subagent** (an
 *   approval, an out-of-process worker reporting through another channel) is
 *   still not covered; the same pause/resume shape extends to it, with a
 *   different trigger.
 *
 * ## The seam it reads, and the 0.2.0 repair
 *
 * Both dimensions program only against documented public surfaces. The jobs
 * dimension was written against the registry as it stood *before* the
 * 2026-09-03 seam consolidation and kept two assumptions that consolidation
 * removed:
 *
 * - `JobRegistry.list` takes the caller's **session id**, and `JobView.owner`
 *   is that session id — never the `Agent`. v0.1.0 passed the agent, so no owned
 *   job was ever visible.
 * - Settlements arrive on the registry's one event stream,
 *   `jobs.events.subscribe(filter, listener)`. The three listener families it
 *   replaced — `onJobDone`, `onJobsChanged`, `onOutput` — are gone, so v0.1.0's
 *   settlement hook never existed to be called.
 *
 * The two compounded into the worst outcome this file can produce, and it was
 * **not** inert: `list`'s unowned disjunct still admitted every unowned job, so
 * a running shared job *did* pause the goal — and the pause could never be
 * lifted, because the resume rode the hook that no longer exists. That is the
 * stranded goal {@link resumeDecision} calls worse than lifting early. 0.2.0
 * repairs both: the caller is the session id, and the settlement rides the
 * documented event stream.
 *
 * ## The seam the child dimension reads (0.3.0)
 *
 * The delegated-child dimension is a **live read**, not an event-paired
 * counter, for the reason the jobs dimension is: a counter that has to be kept
 * in step with two edge types drifts, and a drifted count either never defers
 * or never lifts. What it reads:
 *
 * - `ctx.agents.list()` — every live `Agent`, each exposing `id` and `status`
 *   (`'idle' | 'running'`).
 * - `agent.session.header` — the durable `SessionHeader`, whose `parentSession`
 *   and `origin: 'subagent'` are what `childSessionMeta` stamps on every child
 *   a provider composes in process.
 *
 * Settlements are **triggers to re-read**, never sources of truth. The trigger
 * is the child's **own** `agent/status` at `idle`, and its `agent/disposed`:
 * both carry the child `Agent`, whose durable header already names its parent,
 * so the release is attributed without pairing a run id and without looking a
 * session up. `subagent/end` is deliberately not used — its payload names a run
 * and not a parent, so attribution would have to go through a lookup that races
 * the child's own disposal, and a continuable child keeps its residency epoch
 * open across turns: a child that finished the turn its parent was waiting on
 * may not publish a terminal edge for a long time, while its `status` stops
 * being `running` immediately. The child's own edge is both the cheaper and the
 * more timely trigger.
 *
 * @packageDocumentation
 */
import z from '@deepseek-ai/schemastery';
/** Plugin name, as the loader registers it. */
export const name = 'goal-progress-guard';
/**
 * The services this plugin reads. Only the goal service is required: the jobs
 * service is injected optionally in {@link apply}, so a composition without
 * background jobs still mounts this plugin and still gets the no-progress rule.
 */
export const inject = ['goals'];
/** Schemastery config for the progress policy. */
export const Config = z.object({
    maxBarrenRounds: z.number().step(1).min(1).required(false),
    deferWhileJobsPending: z.boolean().default(true),
    deferWhileSubagentsPending: z.boolean().default(true),
    maxDeferMs: z.number().step(1).min(1).required(false),
    dryRun: z.boolean().default(false),
});
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
export function advanceBarrenStreak(window) {
    if (!window.roundSettled)
        return 0;
    return window.toolCalls === 0 ? window.barrenStreak + 1 : 0;
}
/**
 * The work one observation counts, in the guard's own terms.
 *
 * A disabled dimension contributes nothing, and an **unobservable** one
 * contributes nothing either — neither can be the reason a deferral is held,
 * which is why the two are one number rather than two: one unsettled job and
 * one running child are the same reason to wait. This is also the number that
 * decides whether a capped episode has drained.
 *
 * @param observed - the counts read for one agent.
 * @returns how many pieces of work this guard is waiting for, never negative.
 */
export function pendingWork(observed) {
    const jobs = observed.deferWhileJobsPending ? observed.unsettledJobs ?? 0 : 0;
    const children = observed.deferWhileSubagentsPending ? observed.unsettledSubagents ?? 0 : 0;
    return jobs + children;
}
/**
 * Decide whether the goal should be paused to wait for work already running.
 *
 * Only an `active`, `armed` goal is deferred — a paused or blocked goal has
 * nothing to defer — and an unobservable count never defers, so a composition
 * without the jobs or agents service behaves exactly as it did before the
 * corresponding dimension existed. A goal whose deadline already lifted one
 * deferral is not deferred again until its work drains, because re-pausing
 * would withdraw the very round the deadline released.
 *
 * @param observed - the quantities read for one agent.
 * @returns `defer` when the goal should wait.
 */
export function deferDecision(observed) {
    if (observed.phase !== 'active' || observed.activation !== 'armed')
        return 'none';
    if (observed.capped)
        return 'none';
    return pendingWork(observed) > 0 ? 'defer' : 'none';
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
export function blockDecision(observed) {
    if (observed.maxBarrenRounds === undefined)
        return undefined;
    if (observed.phase !== 'active')
        return undefined;
    if (observed.barrenStreak < observed.maxBarrenRounds)
        return undefined;
    return {
        code: 'no-progress',
        message: `Goal stopped: ${observed.barrenStreak} consecutive rounds completed without a single tool call. `
            + 'It is repeating itself rather than working; resume it when there is something new to do.',
    };
}
/**
 * Decide whether a goal this plugin paused should be resumed.
 *
 * Three asymmetries are deliberate:
 *
 * - a goal that is no longer `paused` was moved by someone else (a human, or
 *   the round-limit block), so the record is simply forgotten rather than
 *   fought over;
 * - an unobservable pending count resumes rather than stays paused. Staying
 *   paused is the failure that strands the goal — the plugin's own pause must
 *   always be releasable, and a deferral that cannot be lifted is worse than
 *   one that lifts early;
 * - a deferral held past its deadline is lifted even though its work is still
 *   observable, for the same reason: observable work that never finishes would
 *   otherwise hold the goal for as long as the composition lives.
 *
 * @param observed - the quantities read for one agent.
 * @returns `resume`, `forget`, or `none`.
 */
export function resumeDecision(observed) {
    if (observed.phase !== 'paused')
        return 'forget';
    if (observed.deadlineReached)
        return 'resume';
    if ((observed.unsettledJobs ?? 0) > 0)
        return 'none';
    if ((observed.unsettledSubagents ?? 0) > 0)
        return 'none';
    return 'resume';
}
/** Whether a job has not reached a terminal state. */
export function isUnsettled(job) {
    return job.status === 'running' || job.status === 'stopping';
}
/**
 * Whether one session event is a durable tool call.
 *
 * Structural, and deliberately not a value import: `tool/call` is a declared
 * event type of the session package, and this plugin only reads it.
 */
export function isToolCallEvent(event) {
    return event?.type === 'tool/call';
}
/**
 * Whether one live agent is a delegated child of `parentSessionId` that is
 * still running.
 *
 * The three conditions are each load-bearing:
 *
 * - `origin === 'subagent'` keeps a **forked** session out of the count. A fork
 *   records `parentSession` too, and a fork is a sibling, not work the parent
 *   is waiting on.
 * - `status === 'running'` is what makes this a count of *work in flight*.
 *   A continuable child stays resident between turns; counting residency rather
 *   than execution would hold the goal from the moment a child was created
 *   until it was closed, which is not a wait.
 * - the parent comparison is the durable dispatch lineage `childSessionMeta`
 *   stamps on every child a provider composes in process.
 *
 * @param agent - one live agent.
 * @param parentSessionId - the session whose delegated work is being counted.
 * @returns whether this agent counts as that session's running child.
 */
export function isRunningChild(agent, parentSessionId) {
    if (agent.id === parentSessionId)
        return false;
    if (agent.status !== 'running')
        return false;
    const header = agent.session?.header;
    return header?.origin === 'subagent' && header.parentSession === parentSessionId;
}
/** Human-readable unexpected values for logs. */
function renderThrown(value) {
    return value instanceof Error ? value.message : String(value);
}
/** One agent's session, or `undefined` when the shape is not the expected one. */
function sessionIdOf(agent) {
    const session = agent?.session;
    const id = session?.id;
    return typeof id === 'string' ? id : undefined;
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
export function createProgressGuard(ctx, config) {
    const states = new Map();
    /**
     * The jobs service, once installed. Not read from `ctx`: this plugin does not
     * require the service, and an undeclared read would throw at mount.
     */
    let jobs;
    /**
     * The agent registry, once installed. Optional for the same reason `jobs`
     * is, and by the same mechanism.
     */
    let agents;
    const deferJobsEnabled = config.deferWhileJobsPending !== false;
    const deferChildrenEnabled = config.deferWhileSubagentsPending !== false;
    const maxDeferMs = config.maxDeferMs;
    const maxBarrenRounds = config.maxBarrenRounds;
    const dryRun = config.dryRun === true;
    function stateOf(sessionId) {
        const existing = states.get(sessionId);
        if (existing !== undefined)
            return existing;
        const fresh = {
            lastRoundsStarted: undefined,
            toolCallsInWindow: 0,
            barrenStreak: 0,
            deferred: undefined,
            capped: false,
        };
        states.set(sessionId, fresh);
        return fresh;
    }
    /** One agent's goal view, or `undefined` when there is none or the read fails. */
    function readGoal(agent) {
        try {
            return ctx.goals.get(agent);
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not read the current goal: ${renderThrown(error)}`);
            return undefined;
        }
    }
    /**
     * Unsettled jobs this session owns, or `undefined` when not observable.
     *
     * The caller is a session id by construction — the registry compares it
     * against the owning session, so handing it the agent would match no owned
     * job and silently leave only the unowned disjunct. Both call sites already
     * hold the id, so the invariant rides the parameter type rather than a runtime
     * branch nothing can reach.
     */
    function unsettledJobs(sessionId) {
        if (jobs === undefined)
            return undefined;
        try {
            return jobs.list(sessionId).filter(isUnsettled).length;
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not read background jobs: ${renderThrown(error)}`);
            return undefined;
        }
    }
    /**
     * Delegated children of this session that are still running, or `undefined`
     * when the registry is not installed.
     *
     * This is a live read rather than a counter kept in step with two edges, for
     * the reason the jobs dimension is: a count that has to agree with a start
     * and an end drifts, and a drifted count either never defers or never lifts.
     */
    function unsettledSubagents(sessionId) {
        if (agents === undefined)
            return undefined;
        try {
            return agents.list().filter(candidate => isRunningChild(candidate, sessionId)).length;
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not read the live agents: ${renderThrown(error)}`);
            return undefined;
        }
    }
    /** One agent's count of work this deployment waits for, and the goal it belongs to. */
    function observe(agent, goal, capped) {
        const sessionId = sessionIdOf(agent) ?? '';
        return {
            deferWhileJobsPending: deferJobsEnabled,
            deferWhileSubagentsPending: deferChildrenEnabled,
            phase: goal.phase,
            activation: goal.activation,
            unsettledJobs: unsettledJobs(sessionId),
            unsettledSubagents: unsettledSubagents(sessionId),
            capped,
        };
    }
    const refOf = (goal) => ({ id: goal.id, revision: goal.revision });
    function observeToolCall(sessionId) {
        stateOf(sessionId).toolCallsInWindow += 1;
    }
    function evaluate(agent) {
        const sessionId = sessionIdOf(agent);
        if (sessionId === undefined)
            return;
        const goal = readGoal(agent);
        if (goal === undefined) {
            clearState(sessionId);
            return;
        }
        const state = stateOf(sessionId);
        const observed = observe(agent, goal, state.capped);
        // A cap lasts only as long as the work it was holding for. Once that work
        // is gone the goal is judged by the ordinary rules again.
        if (pendingWork(observed) === 0)
            state.capped = false;
        // 1. Work already running outranks another round. Taken before the streak
        //    bookkeeping: a round that ended in order to wait was not barren, so a
        //    deferral must not advance the streak.
        if (deferDecision({ ...observed, capped: state.capped }) === 'defer') {
            writeDeferral(agent, goal, sessionId, state);
            state.barrenStreak = 0;
            state.lastRoundsStarted = goal.roundsStarted;
            state.toolCallsInWindow = 0;
            return;
        }
        // 2. A round the guard's own deadline admitted is not drift. The round was
        //    released by this plugin, not chosen by a loop that had run out of
        //    things to do, and charging it would stop a goal whose work is
        //    demonstrably still running — the outcome the cap exists to avoid.
        if (state.capped) {
            state.lastRoundsStarted = goal.roundsStarted;
            state.toolCallsInWindow = 0;
            return;
        }
        // 3. A window is only judged once a previous edge defines it: on first
        //    sight there is no window, and guessing one would charge the goal for
        //    rounds that ran before this plugin was mounted.
        if (state.lastRoundsStarted === undefined) {
            state.lastRoundsStarted = goal.roundsStarted;
            state.toolCallsInWindow = 0;
            return;
        }
        state.barrenStreak = advanceBarrenStreak({
            barrenStreak: state.barrenStreak,
            roundSettled: goal.roundsStarted > state.lastRoundsStarted,
            toolCalls: state.toolCallsInWindow,
        });
        state.lastRoundsStarted = goal.roundsStarted;
        state.toolCallsInWindow = 0;
        const reason = blockDecision({ maxBarrenRounds, barrenStreak: state.barrenStreak, phase: goal.phase });
        if (reason === undefined)
            return;
        if (dryRun) {
            ctx.logger.info(`goal-progress-guard: would stop goal "${goal.id}" with "${reason.code}" (dry-run)`);
            return;
        }
        try {
            ctx.goals.block(agent, refOf(goal), reason);
            ctx.logger.info(`goal-progress-guard: stopped goal "${goal.id}" with "${reason.code}"`);
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not stop goal "${goal.id}": ${renderThrown(error)}`);
        }
    }
    /**
     * Pause one goal and record the deferral, arming its deadline.
     *
     * The deadline is a timer rather than a timestamp compared on the next visit,
     * because during a deferral there may be **no** next visit: the goal is
     * paused, so the driver queues no round, and a stuck child or a hung job
     * produces no edge at all. A deadline nothing fires on is not a deadline.
     *
     * `maxDeferMs` is unset by default, in which case nothing is armed and the
     * deferral is held for as long as its work is observable — the behaviour every
     * release before 0.3.0 had.
     */
    function writeDeferral(agent, goal, sessionId, state) {
        if (dryRun) {
            ctx.logger.info(`goal-progress-guard: would pause goal "${goal.id}" while earlier work runs (dry-run)`);
            return;
        }
        if (!pauseGoal(agent, goal))
            return;
        state.deferred = armDeferral(agent, sessionId);
    }
    /** The deferral record for one freshly paused goal, with its deadline armed. */
    function armDeferral(agent, sessionId) {
        if (maxDeferMs === undefined || ctx.schedule === undefined)
            return { agent, disarm: undefined };
        return { agent, disarm: ctx.schedule(() => { releaseAtDeadline(sessionId); }, maxDeferMs) };
    }
    /** Pause one goal, reporting whether the pause was actually written. */
    function pauseGoal(agent, goal) {
        try {
            ctx.goals.pause(agent, refOf(goal));
            ctx.logger.info(`goal-progress-guard: paused goal "${goal.id}" while earlier work runs`);
            return true;
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not pause goal "${goal.id}": ${renderThrown(error)}`);
            return false;
        }
    }
    /**
     * Reconsider one agent's deferral, whoever triggered it.
     *
     * `deadlineReached` says the deferral outlived `maxDeferMs`, and only the code
     * that *knows* — the timer that was armed for exactly that — may say so. The
     * decision is deliberately not re-derived from a clock here: a spent timer
     * that consulted the clock and found it not yet time would answer "keep
     * waiting" with nothing left to fire, which is the one outcome worse than
     * resuming early. A resume the deadline forced is recorded as a capped
     * episode, which suppresses the next deferral until the work drains.
     */
    function release(agent, deadlineReached) {
        const sessionId = sessionIdOf(agent);
        if (sessionId === undefined)
            return;
        const state = states.get(sessionId);
        if (state?.deferred === undefined)
            return;
        const deferral = state.deferred;
        const goal = readGoal(agent);
        const decision = resumeDecision({
            phase: goal?.phase ?? 'absent',
            unsettledJobs: unsettledJobs(sessionId),
            unsettledSubagents: unsettledSubagents(sessionId),
            deadlineReached,
        });
        if (decision === 'none')
            return;
        deferral.disarm?.();
        state.deferred = undefined;
        if (decision === 'forget' || goal === undefined)
            return;
        if (dryRun) {
            ctx.logger.info(`goal-progress-guard: would resume goal "${goal.id}" after its work settled (dry-run)`);
            return;
        }
        try {
            ctx.goals.resume(agent, refOf(goal));
            ctx.logger.info(`goal-progress-guard: resumed goal "${goal.id}" after its work settled`);
        }
        catch (error) {
            ctx.logger.warn(`goal-progress-guard: could not resume goal "${goal.id}": ${renderThrown(error)}`);
            return;
        }
        if (deadlineReached)
            state.capped = true;
        state.lastRoundsStarted = goal.roundsStarted;
        state.toolCallsInWindow = 0;
    }
    /** Reconsider one deferred session, looked up by the id the registry reports. */
    function releaseSession(sessionId) {
        const state = states.get(sessionId);
        if (state?.deferred === undefined)
            return;
        release(state.deferred.agent, false);
    }
    /** Lift one session's deferral because the deadline armed for it elapsed. */
    function releaseAtDeadline(sessionId) {
        const state = states.get(sessionId);
        if (state?.deferred === undefined)
            return;
        release(state.deferred.agent, true);
    }
    /**
     * Reconsider a deferral after a settlement, whoever triggered it.
     *
     * The owner arrives as the registry reports it on `JobView`: a session id for
     * an owned job, `undefined` for an unowned one. An unowned job is visible to
     * every agent, so its settlement can lift any deferral.
     */
    function jobSettled(owner) {
        if (owner !== undefined) {
            releaseSession(owner);
            return;
        }
        for (const state of [...states.values()]) {
            if (state.deferred !== undefined)
                release(state.deferred.agent, false);
        }
    }
    /**
     * Reconsider a parent's deferral after one of its delegated children stopped.
     *
     * The child is the attribution: its durable header names the parent, so
     * nothing has to be paired or looked up, and a child a provider runs out of
     * process has no `Agent` here to arrive at all. Anything that is not a
     * delegated child — a top-level session, a fork — is ignored, which is what
     * makes this safe on every quiescent edge.
     */
    function childSettled(agent) {
        const header = agent?.session?.header;
        if (header?.origin !== 'subagent')
            return;
        const parent = header.parentSession;
        if (typeof parent !== 'string')
            return;
        releaseSession(parent);
    }
    /** Drop one session's bookkeeping, disarming anything it had armed. */
    function clearState(sessionId) {
        states.get(sessionId)?.deferred?.disarm?.();
        states.delete(sessionId);
    }
    function forget(agent) {
        const sessionId = sessionIdOf(agent);
        if (sessionId !== undefined)
            clearState(sessionId);
    }
    /** Install the jobs service once it becomes available. */
    function attachJobs(source) {
        jobs = source;
    }
    /** Install the agent registry once it becomes available. */
    function attachAgents(source) {
        agents = source;
    }
    function observed(sessionId) {
        const state = states.get(sessionId);
        return {
            lastRoundsStarted: state?.lastRoundsStarted,
            toolCallsInWindow: state?.toolCallsInWindow ?? 0,
            barrenStreak: state?.barrenStreak ?? 0,
            deferred: state?.deferred !== undefined,
            capped: state?.capped ?? false,
        };
    }
    return { observeToolCall, evaluate, jobSettled, childSettled, forget, attachJobs, attachAgents, observed };
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
export function mountLine(config) {
    const jobs = config.deferWhileJobsPending !== false ? 'on' : 'off';
    const children = config.deferWhileSubagentsPending !== false ? 'on' : 'off';
    const barren = config.maxBarrenRounds === undefined ? 'unset' : String(config.maxBarrenRounds);
    const cap = config.maxDeferMs === undefined ? 'unset' : String(config.maxDeferMs);
    const inert = config.deferWhileJobsPending === false
        && config.deferWhileSubagentsPending === false
        && config.maxBarrenRounds === undefined;
    return `goal-progress-guard: deferWhileJobsPending=${jobs}`
        + `, deferWhileSubagentsPending=${children}`
        + `, maxDeferMs=${cap}`
        + `, maxBarrenRounds=${barren}`
        + `${config.dryRun === true ? ' (dry-run)' : ''}`
        + `${inert ? ' — the guard is inert' : ''}`;
}
/**
 * Mount the guard.
 *
 * Three listeners and two optional injections:
 *
 * - `session/event` counts durable `tool/call` events, which is the evidence
 *   the no-progress rule is decided from;
 * - `agent/status` at `idle` is the decision edge, **prepended** so the
 *   deferral lands before the goal-round driver's own listener can queue the
 *   next round. That ordering is not cosmetic: when the driver has no pending
 *   durability checkpoint its listener reaches `agent.followup` synchronously
 *   within the same emit, so a pause registered after it would arrive one round
 *   too late, every round. The same edge is also the child's own settlement:
 *   a delegated child arriving here has stopped running, so the parent it names
 *   is reconsidered;
 * - `agent/disposed` releases the bookkeeping, and for a delegated child it is
 *   the other way a child stops counting as work in flight;
 * - `jobs` and `agents` are injected optionally, so the no-progress dimension
 *   works in a composition with neither, and each deferral dimension appears
 *   only where waiting is actually possible.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved deployment policy.
 */
export function apply(ctx, config = {}) {
    // Deadline timers are owned here rather than by the guard, so unloading the
    // plugin cancels every one of them: an armed timer that outlived its mount
    // would release a deferral nothing is tracking any more.
    const timers = new Set();
    ctx.effect(() => () => {
        for (const handle of timers)
            clearTimeout(handle);
        timers.clear();
    });
    const schedule = (fire, delayMs) => {
        const handle = setTimeout(() => {
            timers.delete(handle);
            fire();
        }, delayMs);
        timers.add(handle);
        return () => {
            clearTimeout(handle);
            timers.delete(handle);
        };
    };
    const harness = ctx;
    const guard = createProgressGuard({ goals: harness.goals, logger: harness.logger, schedule }, config);
    ctx.logger.info(mountLine(config));
    const on = ctx.on;
    // Evidence: a durable tool call in the window between two quiescent edges.
    on('session/event', (session, event) => {
        if (!isToolCallEvent(event))
            return;
        if (typeof session?.id === 'string')
            guard.observeToolCall(session.id);
    });
    // Decision edge, ordered ahead of the driver's own listener. The child
    // release rides the same edge: a delegated child that reaches `idle` is work
    // the parent is no longer waiting for.
    on('agent/status', (payload) => {
        if (payload?.status !== 'idle')
            return;
        guard.evaluate(payload.agent);
        guard.childSettled(payload.agent);
    }, { prepend: true });
    on('agent/disposed', (payload) => {
        guard.childSettled(payload.agent);
        guard.forget(payload.agent);
    });
    // The agent registry is optional by design, exactly as the jobs service is:
    // a composition without it leaves the child dimension inert and the rest of
    // the guard untouched.
    ctx.inject(['agents'], (agentsCtx) => {
        guard.attachAgents(agentsCtx.agents);
    });
    // The jobs service is optional by design: a composition without it keeps the
    // no-progress dimension and leaves the job dimension inert.
    //
    // Settlements ride the registry's one event stream, subscribed by scope: the
    // plugin serves the composition it is mounted in, and must not hear another
    // preset's agents. `settled` carries the job's projection, whose `owner` is
    // the session id the deferral bookkeeping is keyed by.
    ctx.inject(['jobs'], (jobsCtx) => {
        const jobs = jobsCtx.jobs;
        guard.attachJobs(jobs);
        jobsCtx.effect(() => jobs.events.subscribe({ owners: 'scope' }, (event) => {
            if (event.type !== 'settled')
                return;
            guard.jobSettled(event.job?.owner);
        }));
    });
}
