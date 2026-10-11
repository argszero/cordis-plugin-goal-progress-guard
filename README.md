# @argszero/cordis-plugin-goal-progress-guard

Progress judgement for **dsh autonomous goal rounds**: pause a goal while its background jobs are
still running, and stop a goal whose rounds have stopped producing tool calls.

```sh
npm install @argszero/cordis-plugin-goal-progress-guard
```

## The gap this closes

A goal (`@deepseek-ai/dsh-goal` + `@deepseek-ai/dsh-goal-round-driver`) keeps a session working
after the human's turn ends: each time the session goes quiescent the driver queues one more round,
for as long as the goal is `active` and `armed`. The driver has exactly one reason to stop — the
goal's own `maxGoalRounds` — and no notion of whether a round accomplished anything.

`idle` means only *"no turn is running"*. So an agent that has just started a background job and
ended its turn to wait for it is **indistinguishable, at that signal, from an agent that is
finished**. Two failure modes follow, both reported upstream ([#7198](https://github.com/deepseek-ai/deepseek-harness/discussions/7198),
with [#1831](https://github.com/deepseek-ai/deepseek-harness/discussions/1831) and [#4664](https://github.com/deepseek-ai/deepseek-harness/discussions/4664)):

- **forced speech** — the agent cannot wait for anything, so every round must produce output even
  when there is nothing to say. #4664 recorded it fabricating a sense of elapsed time
  (`~15/20/25 min in`), which later rounds then read back as fact.
- **drift** — #1831 recorded 160 near-identical rounds before a human stopped it.

## Mount

```yaml
- insert:
    - id: goal-progress-guard
      name: '@argszero/cordis-plugin-goal-progress-guard'
      config:
        deferWhileJobsPending: true   # default: pause while jobs run, resume when they settle
        maxBarrenRounds: 3            # stop after N consecutive rounds with no tool call
        dryRun: false                 # true logs the deferral or stop it would write
```

## What it does

### 1. Pending work defers the loop (`deferWhileJobsPending`, default on)

At every quiescent edge, if the agent still owns an **unsettled** job (`running` or `stopping`), the
goal is `pause`d instead of being allowed to take another round. When the last job settles, the goal
is `resume`d. The rounds in between are exactly the ones the agent would otherwise have spent
talking to itself while waiting.

`pause` — not `block`. **Stop and defer are different harness operations**: `pause` keeps the goal
alive and resumable, while `block` is terminal until a human resumes it. A stall in a live loop is a
deferral; only a run of barren rounds is a verdict.

### 2. A round that produced nothing is counted (`maxBarrenRounds`, unset = unenforced)

Tracks consecutive settled rounds in which no `tool/call` was written to the session, and stops the
goal with a durable `no-progress` reason. This is the cheapest form of the "no progress" rule and
needs no extra model call — which is the point Codex's goal cookbook makes when it suppresses a
continuation turn that made no tool call.

The window is the span **between two quiescent edges**, and a window in which no round was admitted
(because the human was driving) does not count toward the streak. Tool calls are read from the
durable session log, so the rule is replayable rather than live-only.

The two dimensions are independent: an evaluation planner is a different question, and neither
depends on one.

## Boundaries (all of them)

- **Nothing interrupts work in flight.** Both decisions are taken when the agent is quiescent; a
  running turn is never cancelled by this plugin.
- **`stopping` counts as unsettled.** A job being killed has not settled — it still reports
  `finishedAt === undefined`.
- **No jobs service, no deferral.** The jobs service is injected optionally, so a composition
  without background jobs still mounts this plugin and still enforces the no-progress rule; the
  deferral dimension just stays inert.
- **A deferral is always releasable.** If the job count becomes unobservable while a goal is paused
  by this plugin, the goal is resumed rather than left stranded — a pause that cannot be lifted is
  worse than one that lifts early. A goal someone else moved (a human, or the round-limit block) is
  forgotten rather than fought over.
- **An unobservable count never defers and never stops.** A guard that guesses is worse than one
  that abstains, and every abstention is logged.
- **The first sight of a goal seeds the window** instead of judging it: rounds that ran before the
  guard was mounted are not charged to it.
- **Waiting for something that is not a job** (an approval, a subagent reporting through another
  channel) is not covered. The same pause/resume shape extends to it with a different trigger.

## The seam, and the 0.2.0 repair

Both dimensions program only against documented public surfaces, and the jobs half was written
against a seam the harness has since consolidated. **0.1.0 was broken against every shipped
harness** — it kept two assumptions the 2026-09-03 consolidation removed (upstream
`07941fe5e2`, "consolidate the seam into JobSpec, VisibleJobs, and one event stream"):

- **`jobs.list(caller)` takes the caller's session id, and `JobView.owner` is that session id** —
  never the `Agent`. v0.1.0 passed the agent, so the owned-job comparison never matched.
- **Settlements arrive on the registry's one event stream**, `jobs.events.subscribe(filter,
  listener)`. The three listener families it replaced — `onJobDone`, `onJobsChanged`, `onOutput` —
  no longer exist, so v0.1.0's settlement hook was never there to be called.

The two compounded into the worst outcome this plugin can produce, and it was **not** inert:
`list`'s unowned disjunct still admitted every unowned job, so a running shared job *did* pause the
goal — and the pause could never be lifted, because the resume rode a hook that no longer exists.
The goal was stranded. **0.2.0 repairs both halves**: the caller is the session id, and the
settlement rides the documented event stream.

## Verification

33 tests: the pure policy functions exhaustively, plus the guard driven through a **real cordis
`Context`** against stubs that enforce the real services' rules — the CAS ref must be the revision
that was read, `pause`/`block` require an `active` goal, `resume` refuses an already-armed goal, and
the block reason must satisfy the harness validator copied verbatim from
`packages/goal/goal/src/index.ts`. The suite carries a **control arm** (without the plugin, an idle
agent with a running job is left alone), a **listener-ordering test** — the deferral only works if
this plugin's `agent/status` listener runs before the driver's own — and a **settlement test** that
drives a real registry event through the subscription and checks the deferral actually lifts.

The `jobs` stand-in enforces the **real** contract, and that is the point: the version that shipped
compared `job.owner?.id === caller?.id`, mirroring the implementation's own mistake instead of the
registry's rule, so 30 green tests certified a plugin that could not work. A fixture that agrees
with the code proves nothing.

10 mutation checks (`npm run test:defects`) — the job lookup's caller, the subscription, the event
filter, the settlement path, and the unobservable-count handling — are each compiled and run
against the suite; 9 are killed and 1 is recorded as equivalent, with the argument for why in the
arm itself.

## Related

- Source discussion: [deepseek-ai/deepseek-harness#7198](https://github.com/deepseek-ai/deepseek-harness/discussions/7198)
- The other half of the same loop — bounding a goal's *spend* rather than its *progress*:
  [`@argszero/cordis-plugin-goal-budget-guard`](https://www.npmjs.com/package/@argszero/cordis-plugin-goal-budget-guard)

## License

MIT
