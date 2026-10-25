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
import type { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
/** Plugin name, as the loader registers it. */
export declare const name = "goal-progress-guard";
/**
 * The services this plugin reads. Only the goal service is required: the jobs
 * service is injected optionally in {@link apply}, so a composition without
 * background jobs still mounts this plugin and still gets the no-progress rule.
 */
export declare const inject: string[];
/** Deployment policy for goal-round progress. */
export interface Config {
    /**
     * Consecutive settled rounds with no `tool/call` that stop the goal. Unset
     * means the dimension is not enforced.
     */
    maxBarrenRounds?: number;
    /**
     * Pause an active goal while the agent still owns an unsettled job, and
     * resume it when the last one settles. Defaults to `true`; set `false` to
     * keep only the other dimensions.
     */
    deferWhileJobsPending?: boolean;
    /**
     * Pause an active goal while the agent still has a delegated child running,
     * and resume it when the last one stops running. Defaults to `true`; set
     * `false` to keep only the other dimensions.
     */
    deferWhileSubagentsPending?: boolean;
    /**
     * How long one deferral may be held before the guard lifts it and admits the
     * round anyway. Unset — the default — means a deferral is held for as long as
     * its work is observable, which is the behaviour every release before 0.3.0
     * had.
     *
     * **This is a safety valve, not a heartbeat.** It exists for work that never
     * finishes: a job whose producer hung, a child stuck mid-turn. A round spent
     * waiting is exactly what the deferral exists to avoid, so a value here is a
     * bound on the damage rather than a cadence — a few minutes above the longest
     * legitimate wait is the intended setting.
     */
    maxDeferMs?: number;
    /** Log the stop or deferral this policy would perform instead of performing it. */
    dryRun?: boolean;
}
/** Schemastery config for the progress policy. */
export declare const Config: z<Config>;
/** A window between two quiescent edges, judged as one admitted round. */
export interface RoundWindow {
    /** Rounds already counted as having produced nothing. */
    readonly barrenStreak: number;
    /** Whether a round was admitted in this window. */
    readonly roundSettled: boolean;
    /** `tool/call` events observed inside the window. */
    readonly toolCalls: number;
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
export declare function advanceBarrenStreak(window: RoundWindow): number;
/** The quantities the deferral decision is taken from. */
export interface DeferObservation {
    /** Whether the job dimension is enabled for this deployment. */
    readonly deferWhileJobsPending: boolean;
    /** Whether the delegated-child dimension is enabled for this deployment. */
    readonly deferWhileSubagentsPending: boolean;
    /** Durable goal phase. */
    readonly phase: string;
    /** Live goal activation. */
    readonly activation: string;
    /** Unsettled jobs owned by this agent, or `undefined` when not observable. */
    readonly unsettledJobs: number | undefined;
    /** Delegated children still running, or `undefined` when not observable. */
    readonly unsettledSubagents: number | undefined;
    /**
     * Whether a deferral of this goal was already lifted by its deadline. A
     * capped episode is not deferred again — re-pausing would withdraw the very
     * round the deadline just released, every round, and the goal would never
     * take one.
     */
    readonly capped: boolean;
}
/** The subset of {@link DeferObservation} the pending count is read from. */
export type PendingObservation = Pick<DeferObservation, 'deferWhileJobsPending' | 'deferWhileSubagentsPending' | 'unsettledJobs' | 'unsettledSubagents'>;
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
export declare function pendingWork(observed: PendingObservation): number;
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
export declare function deferDecision(observed: DeferObservation): 'defer' | 'none';
/** The quantities the no-progress decision is taken from. */
export interface BlockObservation {
    /** Configured streak that stops the goal, or `undefined` when unenforced. */
    readonly maxBarrenRounds: number | undefined;
    /** Streak after the window just closed. */
    readonly barrenStreak: number;
    /** Durable goal phase. */
    readonly phase: string;
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
export declare function blockDecision(observed: BlockObservation): {
    code: string;
    message: string;
} | undefined;
/** What to do about a goal this plugin paused earlier. */
export type ResumeDecision = 'resume' | 'forget' | 'none';
/** The quantities the resume decision is taken from. */
export interface ResumeObservation {
    /** Durable goal phase. */
    readonly phase: string;
    /** Unsettled jobs owned by this agent, or `undefined` when not observable. */
    readonly unsettledJobs: number | undefined;
    /** Delegated children still running, or `undefined` when not observable. */
    readonly unsettledSubagents: number | undefined;
    /**
     * Whether this deferral has been held at least as long as `maxDeferMs`.
     * Always `false` when no deadline is configured.
     */
    readonly deadlineReached: boolean;
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
export declare function resumeDecision(observed: ResumeObservation): ResumeDecision;
/** Whether a job has not reached a terminal state. */
export declare function isUnsettled(job: {
    readonly status?: unknown;
}): boolean;
/**
 * Whether one session event is a durable tool call.
 *
 * Structural, and deliberately not a value import: `tool/call` is a declared
 * event type of the session package, and this plugin only reads it.
 */
export declare function isToolCallEvent(event: unknown): boolean;
/** The subset of `GoalView` and the goal service this plugin programs against. */
export interface GoalRefLike {
    readonly id: string;
    readonly revision: number;
}
/** The durable goal view this plugin reads. */
export interface GoalViewLike extends GoalRefLike {
    readonly phase: string;
    readonly activation: string;
    readonly roundsStarted: number;
}
/** The goal service surface this plugin uses, all of it documented and public. */
export interface GoalsLike {
    get(agent: unknown): GoalViewLike | undefined;
    pause(agent: unknown, ref: GoalRefLike): GoalViewLike;
    resume(agent: unknown, ref: GoalRefLike): GoalViewLike;
    block(agent: unknown, ref: GoalRefLike, reason: {
        code: string;
        message: string;
    }): GoalViewLike;
}
/** One job as `JobsService.list` projects it — the `JobView` subset read here. */
export interface JobLike {
    /** Current lifecycle state: `running`, `stopping`, or one terminal value. */
    readonly status: string;
    /** Owning session id; absent for an unowned job, which every caller can see. */
    readonly owner?: string;
}
/**
 * One announcement from the registry's event stream.
 *
 * Only `settled` is read here; the other members (`registered`, `progress`,
 * `stopping`, `removed`, `output`) carry facts this plugin gets from `list`
 * instead, at the moment it actually needs them.
 */
export interface JobEventLike {
    readonly type: string;
    /** The job's fresh projection, on every lifecycle member. */
    readonly job?: JobLike;
}
/**
 * Who a subscription hears about, spelled the way the registry's
 * `JobEventFilter` spells it.
 *
 * `{ owner }` hears that session's jobs plus every unowned job.
 * `{ owners: 'scope' }` hears the owners composed under the subscribing
 * context — the right choice for a plugin, whose mount scope is the composition
 * it serves, and which must not hear another preset's agents.
 */
export type JobEventFilterLike = {
    readonly owner: string;
} | {
    readonly owners: 'all' | 'scope';
};
/** A disposable registration, as `subscribe` returns one. */
export type Disposer = () => void;
/**
 * The jobs service surface this plugin uses, all of it documented and public.
 *
 * The registry's own terms matter here, because both were misread once:
 *
 * - `list` takes the caller's **session id**. Omission sees only unowned jobs.
 *   The registry compares the caller against the owning session, so an `Agent`
 *   matches no owned job and silently degrades to the unowned set.
 * - settlements ride {@link JobsLike.events}. There is exactly one event stream;
 *   a per-listener settlement hook is not part of the seam.
 */
export interface JobsLike {
    /** Caller-owned and unowned jobs, in registration order. */
    list(caller?: string): JobLike[];
    /** The registry's one event stream. */
    readonly events: {
        subscribe(filter: JobEventFilterLike, listener: (event: JobEventLike) => void): Disposer;
    };
}
/**
 * One live agent as the registry exposes it — the `Agent` subset read here.
 *
 * `status` is `'idle' | 'running'`, mirrored on every `agent/status`
 * transition. `session.header` is the durable, deep-frozen `SessionHeader`; a
 * child composed by a provider in process carries `parentSession` (its
 * delegating parent) and `origin: 'subagent'` there.
 */
export interface AgentLike {
    /** The shared agent/session id. */
    readonly id: string;
    /** Current lifecycle state. */
    readonly status: string;
    /** The live session this agent drives. */
    readonly session?: {
        readonly header?: {
            /** Coarse product classification: `'subagent'` for a delegated child. */
            readonly origin?: unknown;
            /** The session this one was forked from *or* dispatched by, if any. */
            readonly parentSession?: unknown;
        };
    };
}
/** The agent registry surface this plugin uses, all of it documented and public. */
export interface AgentsLike {
    /** All live agents, in registration order. */
    list(): AgentLike[];
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
export declare function isRunningChild(agent: AgentLike, parentSessionId: string): boolean;
/**
 * The ambient surface the guard needs, injected so it can be driven in tests.
 *
 * The jobs and agents services are deliberately *not* read from here: reading a
 * service that was not declared in `inject` throws, and both are optional by
 * design, so they are installed through {@link ProgressGuard.attachJobs} and
 * {@link ProgressGuard.attachAgents} instead.
 */
export interface GuardContext {
    readonly goals: GoalsLike;
    readonly logger: {
        info(message: string): void;
        warn(message: string): void;
    };
    /**
     * Arm one one-shot timer, returning the cancel.
     *
     * Supplied by {@link apply}, which owns the mount's lifetime and clears
     * anything still armed when the plugin unloads. It is **optional**: a
     * harness-free caller may drive the guard without a clock, and then a
     * configured `maxDeferMs` has nothing to fire on — the deferral is held
     * exactly as it was before 0.3.0, which is a degradation a caller who set the
     * option must be told about rather than a silent one (the mount always
     * supplies it).
     */
    readonly schedule?: (fire: () => void, delayMs: number) => () => void;
}
/** What the guard currently believes about one session. */
export interface ObservedProgress {
    /** Durable rounds counted at the last quiescent edge, once seen. */
    readonly lastRoundsStarted: number | undefined;
    /** `tool/call` events counted since that edge. */
    readonly toolCallsInWindow: number;
    /** Consecutive settled rounds that produced nothing. */
    readonly barrenStreak: number;
    /** Whether this plugin is currently holding the goal paused. */
    readonly deferred: boolean;
    /** Whether a deferral of this goal was lifted by its deadline and its work has not drained. */
    readonly capped: boolean;
}
/** The progress guard, usable without a harness. */
export interface ProgressGuard {
    /** Count one durable tool call for a session. */
    observeToolCall(sessionId: string): void;
    /** Take both decisions for an agent that has just gone quiescent. */
    evaluate(agent: unknown): void;
    /**
     * Reconsider a deferred goal after a job settled.
     *
     * The argument is the settled job's owner exactly as the registry reports it:
     * a session id, or `undefined` for an unowned job — which every session can
     * see, so it can lift any deferral.
     */
    jobSettled(owner: string | undefined): void;
    /**
     * Reconsider a parent's deferral after one of its delegated children stopped.
     *
     * The argument is the child, so its durable header attributes the release;
     * anything that is not a delegated child is ignored, which makes this safe to
     * call on every quiescent edge.
     */
    childSettled(agent: unknown): void;
    /** Drop everything remembered about one agent. */
    forget(agent: unknown): void;
    /** Install the optional jobs service once it becomes available. */
    attachJobs(jobs: JobsLike): void;
    /** Install the optional agent registry once it becomes available. */
    attachAgents(agents: AgentsLike): void;
    /** What the guard believes about one session, for tests and reporting. */
    observed(sessionId: string): ObservedProgress;
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
export declare function createProgressGuard(ctx: GuardContext, config: Config): ProgressGuard;
/**
 * One line stating what the guard understood, logged at mount.
 *
 * A policy nobody can read back is a policy nobody can trust; this makes the
 * effective configuration visible in the same place every other plugin's is.
 *
 * @param config - the resolved deployment policy.
 * @returns one line, prefixed with the plugin name.
 */
export declare function mountLine(config: Config): string;
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
export declare function apply(ctx: Context, config?: Config): void;
