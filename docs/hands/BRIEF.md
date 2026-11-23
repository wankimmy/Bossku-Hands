# Bossku Hands v1 rebuild brief

Date: 23 Nov 2026. Status: building.

## Why a rebuild

The first Hands layer lived only in an uncommitted working tree on another PC.
GitHub got gitlinks to plain upstream commits, so the code is gone. The old test
and build logs (`docs/legacy-logs/`) are the only record. This brief rebuilds the
core from that record on top of upstream OpenHands `e1b8b60f` (19 Nov 2026).

## What the logs prove (the contract)

From `docs/legacy-logs/full-test.log` (`__tests__/scripts/hands/orchestrator.test.ts`):

- `orch.startSession(chatRequest(repoDir, ...))` starts a session on a local git repo.
- Agent roles are called through one runner: `agent.callsFor("planner")`, coder, reviewer.
- `orch.approve(sessionId, "push_fix")` can be refused: the session stays
  `AWAITING_APPROVAL` and the result carries an `error` object with a code.
  `github.createPull` must not run before the right approval.
- `orch.handleObservation(ciFailure|ciSuccess(sessionId, headSha))` feeds CI results.
- `orch.waitIdle()`, `orch.getSession(id)`, `orch.cancel(id)`, `orch.stop()`.
- Session fields: `state`, `pr.head...`, `counters.ciRepairRounds`, `escalation.reason`.
- States seen: `AWAITING_APPROVAL`, `READY_FOR_HUMAN_REVIEW`, `ESCALATED`.
- Escalation reasons seen: `ci_fix_failed`, `ci_repair_budget_exhausted`,
  `same_failure_repeated_without_progress`, plus an infrastructure-failure reason.
- Behaviours named by tests:
  1. Repair a CI failure on the app-owned PR, push the fix, then go green.
  2. Escalate an infrastructure failure without calling the coder.
  3. Escalate when the same CI failure signature returns after a repair.
  4. Stop repairing when the CI repair budget is used up.
  5. Revert files a reviewer changed and record a warning.
  6. Cancel stops the in-flight planner and finishes the session once.
  7. `stop()` suspends open sessions, aborts stages and leaves no timers behind.

Routes that existed (from the route-map failure): `/hands/sessions`,
`/hands/sessions/:sessionId`, `/hands/sessions/:sessionId/review`, `/hands/reviews`,
`/hands/changes`, `/hands/graph`, `/hands/linear`, and settings pages
`/settings/hands-{workflow,ci,pull-requests,models,skills,security,connections,linear}`.

## v1 scope (this rebuild)

1. `scripts/hands/` orchestrator core: state machine, approval gates, CI repair loop
   with budget and failure signatures, reviewer-edit revert, cancel/stop with no
   leaked timers, JSON persistence. Git runs through `execFile` with argument
   arrays only. Pushes go only to app-owned `hands/<sessionId>` branches, never
   force, never the default branch.
2. Local HTTP API for the UI, bound to 127.0.0.1 only.
3. Frontend: `src/api/hands/` types and service, `/hands/sessions` list,
   `/hands/sessions/:sessionId` detail with approve and cancel, and
   `/settings/hands-workflow` for the repair budget and approval gates.
4. Tests for each behaviour above, written first.

## Out of scope for v1 (follow-ups)

Linear inbox and repo mappings, execution graph, changes and reviews pages,
connections, model roles, skills tester and Bossku doctor, security and PR
settings, CI watch table. Each needs its own brief.

## Owner rules (master prompt V4, re-pasted 23 Nov 2026)

- Keep Electron. Ports: 8100 app, 18000 agent server, 18001 automation.
- CI listener runs only while the app is open: GitHub polling, no webhook, no
  background service. On reopen, restore watched sessions and reconcile.
- Auto Fix CI modes: `off` (report only), `suggest` (diagnose, no writes),
  `local` (fix in the worktree, push needs the `push_fix` approval),
  `update_pr` (push validated fixes, app-owned PRs only). Default `local`.
- Default CI repair budget: 3 rounds, configurable.
- PRs are Draft. Check for an existing PR on the branch before creating one.
- Never auto-merge. Success ends at `READY_FOR_HUMAN_REVIEW`; only GitHub's real
  merged state moves a session to `COMPLETED`. Closed-unmerged is `SUPERSEDED`.
- App shutdown suspends (`SUSPENDED`), it is not a failure.
- Stop and escalate on: same failure without progress, budget used, infra
  failure, missing permission, branch changed unexpectedly, PR closed.

## Assumptions (inferred, not proven by the logs or the spec)

- Approval gates `approve_plan` and `open_pr` are on by default.
- A failure counts as infrastructure when every failed job matches runner,
  network, cancellation or timeout patterns.
- Failure signature = sorted failed job names plus a normalised first error line.
- A PR with no check run 5 minutes after the push counts as "no CI".
- Local verification is the coder agent's job in v1 (it runs the repo's tests).
  A deterministic per-project verify command is a follow-up: on Windows a
  `.cmd` tool such as npm needs a shell, which needs its own guard design.
