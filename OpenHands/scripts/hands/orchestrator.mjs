/**
 * Bossku Hands orchestrator: the state machine that takes one request from a
 * plan to a draft pull request that is ready for a human, and keeps it green.
 *
 *   PLANNING -> [approve_plan] -> CODING -> REVIEWING -> [open_pr] -> OPENING_PR
 *   -> WATCHING_CI -> READY_FOR_HUMAN_REVIEW -> COMPLETED (only on a real merge)
 *
 * A CI failure on the app-owned PR goes through REPAIRING_CI within a bounded
 * budget, then back to WATCHING_CI, or ends in ESCALATED. Agents, GitHub and
 * time are injected, so every transition can be driven by a test.
 *
 * Every stage runs under an AbortController. `cancel` and `stop` abort it, and
 * a stage re-checks its signal after every await, so a late agent reply can
 * never overwrite a cancelled or suspended session.
 */

import { randomBytes } from "node:crypto";
import path from "node:path";

import {
  classifyCiFailure,
  failureSignature,
  redactSecrets,
  sanitizeFailures,
  stripUrlCredentials,
} from "./ci-failure.mjs";
import { createGit } from "./git.mjs";
import {
  coderPrompt,
  parseVerdict,
  plannerPrompt,
  pullRequestText,
  repairPrompt,
  reviewerPrompt,
  truncate,
} from "./prompts.mjs";
import { createSessionStore } from "./session-store.mjs";

export const RUNNING_STATES = new Set([
  "PLANNING",
  "CODING",
  "REVIEWING",
  "OPENING_PR",
  "REPAIRING_CI",
  "PUSHING_FIX",
]);
export const TERMINAL_STATES = new Set([
  "COMPLETED",
  "ESCALATED",
  "CANCELLED",
  "FAILED",
  "SUPERSEDED",
]);

const GATE_NEXT_STATE = {
  approve_plan: "CODING",
  open_pr: "OPENING_PR",
  push_fix: "PUSHING_FIX",
};

export const AUTO_FIX_MODES = ["off", "suggest", "local", "update_pr"];

export const DEFAULT_SETTINGS = Object.freeze({
  gates: Object.freeze({ approve_plan: true, open_pr: true }),
  autoFixCi: "local",
  ciRepairBudget: 3,
  maxReviewRounds: 2,
  ciPollIntervalMs: 30_000,
  roles: Object.freeze({ planner: null, coder: null, reviewer: null }),
  // Linear team key -> where its issues are worked on and which state is Done.
  linear: Object.freeze({ teams: Object.freeze({}) }),
});

export const ROLES = ["planner", "coder", "reviewer"];
const PROFILE_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

// A branch name git cannot mistake for an option (no leading "-").
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;
const MAX_EVENTS = 200;
const PERMISSION_ERROR_CODES = new Set([
  "github_token_missing",
  "github_token_invalid",
  "unsupported_remote",
]);
const MAX_TASK_CHARS = 20_000;
const LINEAR_TEAM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;
const LINEAR_ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;
const MAX_REPO_DIR_CHARS = 1000;

export class HandsError extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.code = code;
    Object.assign(this, extra);
  }
}

const isInt = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max;

/**
 * Validates a settings patch and merges it onto `base`. Unknown keys are
 * ignored; a key with a wrong type or range throws `invalid_settings`.
 */
export function mergeSettings(base, patch = {}) {
  const next = {
    ...base,
    gates: { ...base.gates },
    roles: { ...DEFAULT_SETTINGS.roles, ...base.roles },
    linear: { teams: { ...base.linear?.teams } },
  };
  const fail = (field) =>
    new HandsError("invalid_settings", `invalid value for ${field}`, { field });

  if (patch.gates !== undefined) {
    if (!patch.gates || typeof patch.gates !== "object") throw fail("gates");
    for (const gate of ["approve_plan", "open_pr"]) {
      if (patch.gates[gate] === undefined) continue;
      if (typeof patch.gates[gate] !== "boolean") throw fail(`gates.${gate}`);
      next.gates[gate] = patch.gates[gate];
    }
  }
  if (patch.autoFixCi !== undefined) {
    if (!AUTO_FIX_MODES.includes(patch.autoFixCi)) throw fail("autoFixCi");
    next.autoFixCi = patch.autoFixCi;
  }
  if (patch.ciRepairBudget !== undefined) {
    if (!isInt(patch.ciRepairBudget, 0, 10)) throw fail("ciRepairBudget");
    next.ciRepairBudget = patch.ciRepairBudget;
  }
  if (patch.maxReviewRounds !== undefined) {
    if (!isInt(patch.maxReviewRounds, 1, 5)) throw fail("maxReviewRounds");
    next.maxReviewRounds = patch.maxReviewRounds;
  }
  if (patch.ciPollIntervalMs !== undefined) {
    const value = patch.ciPollIntervalMs;
    if (!(value === 0 || isInt(value, 5_000, 3_600_000))) {
      throw fail("ciPollIntervalMs");
    }
    next.ciPollIntervalMs = value;
  }
  if (patch.roles !== undefined) {
    if (!patch.roles || typeof patch.roles !== "object") throw fail("roles");
    for (const role of ROLES) {
      const value = patch.roles[role];
      if (value === undefined) continue;
      if (
        value !== null &&
        !(typeof value === "string" && PROFILE_ID_PATTERN.test(value))
      ) {
        throw fail(`roles.${role}`);
      }
      next.roles[role] = value;
    }
  }
  if (patch.linear !== undefined) {
    const teams = patch.linear?.teams;
    if (!teams || typeof teams !== "object" || Array.isArray(teams)) {
      throw fail("linear.teams");
    }
    next.linear = { teams: {} };
    for (const [key, value] of Object.entries(teams)) {
      if (!LINEAR_TEAM_KEY_PATTERN.test(key)) throw fail("linear.teams");
      if (!value || typeof value !== "object")
        throw fail(`linear.teams.${key}`);
      const { repoDir = null, baseBranch = null, doneStateId = null } = value;
      if (
        repoDir !== null &&
        !(
          typeof repoDir === "string" &&
          repoDir.length > 0 &&
          repoDir.length <= MAX_REPO_DIR_CHARS
        )
      ) {
        throw fail(`linear.teams.${key}.repoDir`);
      }
      if (
        baseBranch !== null &&
        !(
          typeof baseBranch === "string" &&
          BRANCH_NAME_PATTERN.test(baseBranch) &&
          !baseBranch.includes("..")
        )
      ) {
        throw fail(`linear.teams.${key}.baseBranch`);
      }
      if (
        doneStateId !== null &&
        !(
          typeof doneStateId === "string" && LINEAR_ID_PATTERN.test(doneStateId)
        )
      ) {
        throw fail(`linear.teams.${key}.doneStateId`);
      }
      next.linear.teams[key] = { repoDir, baseBranch, doneStateId };
    }
  }
  return next;
}

/** Loads saved settings leniently: a bad saved value falls back to the default. */
function loadSettings(saved) {
  let settings = mergeSettings(DEFAULT_SETTINGS, {});
  for (const [key, value] of Object.entries(saved ?? {})) {
    try {
      settings = mergeSettings(settings, { [key]: value });
    } catch {
      // keep the default for this key
    }
  }
  return settings;
}

const realClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

const snapshot = (session) => structuredClone(session);

const shortMessage = (error) =>
  redactSecrets(String(error?.stderr || error?.message || error)).slice(0, 500);

/**
 * @param {{
 *   agent: { run(call: { role: string, mode?: string, sessionId: string, cwd: string, prompt: string, signal: AbortSignal }): Promise<{ output: string }> },
 *   github: {
 *     createPull(input: { remoteUrl: string, head: string, base: string, title: string, body: string, draft: boolean }): Promise<{ number: number, url: string }>,
 *     findPull?(input: { remoteUrl: string, head: string }): Promise<{ number: number, url: string } | null>,
 *     getCiStatus?(input: { remoteUrl: string, sha: string, number: number }): Promise<object>,
 *   },
 *   dataDir: string,
 *   settings?: object,
 *   git?: ReturnType<typeof createGit>,
 *   clock?: { now(): number, setTimeout(fn: () => void, ms: number): unknown, clearTimeout(handle: any): void },
 *   onEvent?: (event: { type: string, sessionId: string, session: object }) => void,
 *   createId?: () => string,
 *   linear?: ReturnType<typeof import("./linear.mjs").createLinearClient>,
 * }} deps
 */
export function createOrchestrator(deps) {
  const {
    agent,
    github,
    dataDir,
    git = createGit(),
    clock = realClock,
    onEvent = () => {},
    createId = () => randomBytes(6).toString("hex"),
    linear = null,
  } = deps;
  if (!agent?.run) throw new TypeError("createOrchestrator needs an agent");
  if (!github?.createPull)
    throw new TypeError("createOrchestrator needs github");
  if (!dataDir) throw new TypeError("createOrchestrator needs a dataDir");

  const store = createSessionStore(dataDir);
  let settings = mergeSettings(
    loadSettings(store.loadSettings()),
    deps.settings ?? {},
  );
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, { controller: AbortController, promise: Promise<void> }>} */
  const inflight = new Map();
  /** @type {Map<string, unknown>} */
  const timers = new Map();
  /** @type {Set<Promise<void>>} */
  const polls = new Set();
  let stopped = false;
  /** Linear issue ids with a session being started, against double starts. */
  const startingIssues = new Set();
  /** Session ids with a Linear Done update in flight. */
  const syncingLinear = new Set();

  // A session that was mid-stage when the process died is suspended, not lost.
  for (const saved of store.loadSessions()) {
    if (!saved?.id) continue;
    if (RUNNING_STATES.has(saved.state)) {
      saved.suspendedFrom = saved.state;
      saved.state = "SUSPENDED";
    }
    sessions.set(saved.id, saved);
  }

  const persist = () => store.saveSessions([...sessions.values()]);

  function record(session, type, message) {
    session.updatedAt = new Date(clock.now()).toISOString();
    session.events.push({ at: session.updatedAt, type, message });
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }
    persist();
    onEvent({ type, sessionId: session.id, session: snapshot(session) });
  }

  function transition(session, state, message) {
    session.state = state;
    record(session, "state", message ? `${state}: ${message}` : state);
    if (TERMINAL_STATES.has(state)) finish(session);
  }

  function finish(session) {
    if (session.finishedAt) return;
    clearPoll(session.id);
    session.finishedAt = new Date(clock.now()).toISOString();
    persist();
    // A merged or superseded PR needs its worktree no longer; the branch stays.
    // Escalated, failed and cancelled sessions keep theirs for inspection.
    if (
      (session.state === "COMPLETED" || session.state === "SUPERSEDED") &&
      session.worktreeCreated
    ) {
      const work = cleanUpWorktree(session).finally(() => polls.delete(work));
      polls.add(work);
    }
    if (
      session.state === "COMPLETED" &&
      session.linear &&
      !session.linear.syncedAt
    ) {
      const work = syncLinearDone(session).finally(() => polls.delete(work));
      polls.add(work);
    }
    onEvent({
      type: "session_finished",
      sessionId: session.id,
      session: snapshot(session),
    });
  }

  /**
   * Closes the session's agent conversations (on Windows their terminals
   * keep the worktree folder open), then removes the worktree. A failure is
   * recorded as a warning; the branch always stays.
   */
  async function cleanUpWorktree(session) {
    const ids = (session.conversations ?? []).map((entry) => entry.id);
    if (ids.length > 0 && typeof agent.release === "function") {
      await agent.release(ids).catch(() => {});
    }
    try {
      await git.removeWorktree(session.repoDir, session.worktreeDir);
      session.worktreeCreated = false;
      persist();
    } catch (error) {
      session.warnings.push({
        code: "worktree_cleanup_failed",
        files: [session.worktreeDir],
        message: shortMessage(error),
        at: new Date(clock.now()).toISOString(),
      });
      record(session, "warning", "the worktree folder could not be removed");
    }
  }

  /**
   * Moves the session's Linear issue to its team's Done state. Runs only for
   * a merged PR (COMPLETED) and at most once successfully per session.
   */
  async function syncLinearDone(session) {
    if (
      !linear ||
      !session.linear ||
      session.linear.syncedAt ||
      session.state !== "COMPLETED" ||
      syncingLinear.has(session.id)
    ) {
      return;
    }
    syncingLinear.add(session.id);
    try {
      const mapping = settings.linear?.teams?.[session.linear.teamKey];
      let stateId = mapping?.doneStateId ?? null;
      if (!stateId) {
        const states = await linear.teamStates(session.linear.teamId);
        stateId =
          states.find((state) => state.type === "completed")?.id ?? null;
        if (!stateId) {
          throw new HandsError(
            "linear_done_state_missing",
            "the Linear team has no completed state",
          );
        }
      }
      const state = await linear.moveIssue(session.linear.issueId, stateId);
      session.linear.syncedAt = new Date(clock.now()).toISOString();
      session.linear.syncError = null;
      session.linear.doneState = state?.name ?? null;
      record(
        session,
        "linear",
        `${session.linear.identifier} moved to ${state?.name ?? "Done"} in Linear`,
      );
    } catch (error) {
      session.linear.syncError = error?.code ?? "linear_request_failed";
      session.warnings.push({
        code: "linear_sync_failed",
        files: [],
        message: shortMessage(error),
        at: new Date(clock.now()).toISOString(),
      });
      record(session, "warning", "the Linear issue could not be moved to Done");
    } finally {
      syncingLinear.delete(session.id);
    }
  }

  function escalate(session, reason, detail) {
    session.escalation = { reason, detail: detail ?? null };
    transition(session, "ESCALATED", reason);
  }

  function awaitApproval(session, gate) {
    session.pendingApproval = gate;
    transition(session, "AWAITING_APPROVAL", gate);
  }

  function assertRunning() {
    if (stopped) throw new HandsError("orchestrator_stopped");
  }

  function checkpoint(signal) {
    if (signal.aborted) {
      throw signal.reason ?? new HandsError("aborted");
    }
  }

  /** Runs the session's stages until it waits, finishes or is aborted. */
  function drive(session) {
    const controller = new AbortController();
    const { signal } = controller;
    const promise = (async () => {
      try {
        while (RUNNING_STATES.has(session.state)) {
          checkpoint(signal);
          await STAGES[session.state](session, signal);
        }
      } catch (error) {
        if (signal.aborted) return;
        session.failure = {
          stage: session.state,
          message: shortMessage(error),
        };
        transition(session, "FAILED", session.failure.message);
      } finally {
        if (inflight.get(session.id)?.controller === controller) {
          inflight.delete(session.id);
        }
      }
    })();
    inflight.set(session.id, { controller, promise });
    return promise;
  }

  async function runAgent(session, role, prompt, signal, mode) {
    // Every conversation is recorded, even one whose stage fails, so the
    // clean-up after a merge can close it.
    const remember = (id) => {
      session.conversations ??= [];
      if (!session.conversations.some((entry) => entry.id === id)) {
        session.conversations.push({ role, id });
      }
    };
    const result = await agent.run({
      role,
      mode,
      profileId: session.settings.roles?.[role] ?? null,
      sessionId: session.id,
      cwd: session.worktreeDir,
      prompt,
      signal,
      onConversation: (id) => remember(String(id)),
    });
    checkpoint(signal);
    if (result?.conversationId) remember(String(result.conversationId));
    const blocked = Array.isArray(result?.blocked) ? result.blocked : [];
    if (blocked.length > 0) {
      session.warnings.push({
        code: "commands_blocked",
        role,
        files: [],
        actions: blocked.map(({ action, reason }) => ({
          action: redactSecrets(String(action)),
          reason: String(reason),
        })),
        at: new Date(clock.now()).toISOString(),
      });
      record(
        session,
        "warning",
        `the command guard blocked ${blocked.length} ${role} action(s)`,
      );
    }
    // Agent output is stored, shown in the UI and copied into the PR body.
    return redactSecrets(String(result?.output ?? ""));
  }

  /** Commits the agent's work; true when the branch moved forward. */
  async function commitWork(session, before, message, signal) {
    const { skipped } = await git.commitAll(
      session.worktreeDir,
      message,
      signal,
    );
    checkpoint(signal);
    if (skipped.length > 0) {
      session.warnings.push({
        code: "secret_files_skipped",
        files: skipped,
        at: new Date(clock.now()).toISOString(),
      });
      record(
        session,
        "warning",
        "secret-looking files were left out of the commit",
      );
    }
    const after = await git.headSha(session.worktreeDir);
    checkpoint(signal);
    return after !== before;
  }

  const STAGES = {
    async PLANNING(session, signal) {
      if (!session.worktreeCreated) {
        await git.addWorktree(
          session.repoDir,
          session.worktreeDir,
          session.branch,
          session.baseBranch,
        );
        session.worktreeCreated = true;
        // Saved before the long planner run, so a crash now resumes cleanly.
        record(session, "worktree", session.worktreeDir);
        checkpoint(signal);
      }
      session.plan = await runAgent(
        session,
        "planner",
        plannerPrompt(session),
        signal,
      );
      if (session.settings.gates.approve_plan) {
        awaitApproval(session, "approve_plan");
      } else transition(session, "CODING");
    },

    async CODING(session, signal) {
      const before = await git.headSha(session.worktreeDir);
      checkpoint(signal);
      await runAgent(session, "coder", coderPrompt(session), signal);
      const moved = await commitWork(
        session,
        before,
        `hands: ${pullRequestText(session).title}`,
        signal,
      );
      if (!moved) {
        escalate(session, "coder_made_no_changes");
        return;
      }
      transition(session, "REVIEWING");
    },

    async REVIEWING(session, signal) {
      const before = await git.headSha(session.worktreeDir);
      checkpoint(signal);
      const output = await runAgent(
        session,
        "reviewer",
        reviewerPrompt(session),
        signal,
      );
      await revertUnexpectedEdits(session, before, "reviewer", signal);
      session.counters.reviewRounds += 1;
      session.review = { verdict: parseVerdict(output), notes: output };
      if (session.review.verdict === "APPROVE") {
        if (session.pr) {
          // A reviewed CI fix: push it only when the owner allowed Hands to
          // update the PR on its own.
          if (session.settings.autoFixCi === "update_pr") {
            transition(session, "PUSHING_FIX");
          } else {
            awaitApproval(session, "push_fix");
          }
        } else if (session.settings.gates.open_pr) {
          awaitApproval(session, "open_pr");
        } else {
          transition(session, "OPENING_PR");
        }
        return;
      }
      if (session.counters.reviewRounds >= session.settings.maxReviewRounds) {
        escalate(session, "review_rounds_exhausted");
        return;
      }
      transition(session, "CODING", "reviewer requested changes");
    },

    async OPENING_PR(session, signal) {
      await git.pushBranch(
        session.worktreeDir,
        session.branch,
        signal,
        session.repoDir,
      );
      checkpoint(signal);
      const sha = await git.headSha(session.worktreeDir);
      // A remote URL can carry a token (`https://user:token@github.com/...`);
      // it is never stored, returned by the API or sent to GitHub calls.
      session.remoteUrl = stripUrlCredentials(
        await git.remoteUrl(session.repoDir),
      );
      checkpoint(signal);
      const existing = github.findPull
        ? await github.findPull({
            remoteUrl: session.remoteUrl,
            head: session.branch,
          })
        : null;
      checkpoint(signal);
      const { title, body } = pullRequestText(session);
      const pull =
        existing ??
        (await github.createPull({
          remoteUrl: session.remoteUrl,
          head: session.branch,
          base: session.baseBranch,
          title,
          body,
          draft: true,
        }));
      checkpoint(signal);
      session.pr = {
        number: pull.number,
        url: pull.url,
        head: { ref: session.branch, sha },
        pushedAt: new Date(clock.now()).toISOString(),
      };
      transition(session, "WATCHING_CI", `PR #${pull.number}`);
      schedulePoll(session);
    },

    async REPAIRING_CI(session, signal) {
      const suggestOnly = session.settings.autoFixCi === "suggest";
      const before = await git.headSha(session.worktreeDir);
      checkpoint(signal);
      let output;
      try {
        output = await runAgent(
          session,
          "coder",
          repairPrompt(session, session.lastCiFailures ?? [], { suggestOnly }),
          signal,
          suggestOnly ? "suggest" : "fix",
        );
      } catch (error) {
        if (signal.aborted) throw error;
        escalate(session, "ci_fix_failed", shortMessage(error));
        return;
      }
      if (suggestOnly) {
        await revertUnexpectedEdits(session, before, "coder", signal);
        escalate(session, "fix_suggested", truncate(output, 4000));
        return;
      }
      const moved = await commitWork(
        session,
        before,
        `hands: fix CI (round ${session.counters.ciRepairRounds})`,
        signal,
      );
      if (!moved) {
        escalate(session, "ci_fix_failed", "the coder made no change");
        return;
      }
      // Every automated fix gets its own independent review.
      session.counters.reviewRounds = 0;
      session.review = null;
      transition(session, "REVIEWING", "review the CI fix");
    },

    async PUSHING_FIX(session, signal) {
      await git.pushBranch(
        session.worktreeDir,
        session.branch,
        signal,
        session.repoDir,
      );
      checkpoint(signal);
      session.pr.head.sha = await git.headSha(session.worktreeDir);
      session.pr.pushedAt = new Date(clock.now()).toISOString();
      transition(session, "WATCHING_CI", "pushed fix");
      schedulePoll(session);
    },
  };

  /** Undoes edits made by an agent that must not write, and records a warning. */
  async function revertUnexpectedEdits(session, before, role, signal) {
    const changed = await git.changedFiles(session.worktreeDir);
    const head = await git.headSha(session.worktreeDir);
    checkpoint(signal);
    if (changed.length === 0 && head === before) return;
    await git.discardChanges(session.worktreeDir, before);
    checkpoint(signal);
    session.warnings.push({
      code: `${role}_changed_files`,
      files: changed,
      at: new Date(clock.now()).toISOString(),
    });
    record(session, "warning", `${role} edits were reverted`);
  }

  function clearPoll(sessionId) {
    if (!timers.has(sessionId)) return;
    clock.clearTimeout(timers.get(sessionId));
    timers.delete(sessionId);
  }

  const POLLED_STATES = new Set(["WATCHING_CI", "READY_FOR_HUMAN_REVIEW"]);
  // A push with no check run after this long means the repo has no CI.
  const NO_CHECKS_GRACE_MS = 5 * 60_000;
  const MAX_POLL_BACKOFF_MS = 10 * 60_000;

  /**
   * The CI observer. It lives only as long as this orchestrator (and so the
   * app): `stop()` clears every timer, and nothing polls after that. A PR
   * waiting for a human is polled four times less often than one with CI
   * running, and a failing GitHub call backs off exponentially.
   */
  function schedulePoll(session, delayOverride) {
    const interval = session.settings.ciPollIntervalMs;
    if (stopped || !github.getPullStatus || !interval || !session.pr) return;
    if (!POLLED_STATES.has(session.state)) return;
    clearPoll(session.id);
    const base =
      session.state === "READY_FOR_HUMAN_REVIEW" ? interval * 4 : interval;
    const delay =
      delayOverride ??
      Math.min(base * 2 ** (session.pollFailures ?? 0), MAX_POLL_BACKOFF_MS);
    const handle = clock.setTimeout(() => {
      timers.delete(session.id);
      const work = poll(session).finally(() => polls.delete(work));
      polls.add(work);
    }, delay);
    timers.set(session.id, handle);
  }

  async function poll(session) {
    let status;
    try {
      status = await github.getPullStatus({
        remoteUrl: session.remoteUrl,
        number: session.pr.number,
      });
    } catch (error) {
      if (stopped || !POLLED_STATES.has(session.state)) return;
      // A token or permission problem will not fix itself by retrying.
      if (
        PERMISSION_ERROR_CODES.has(error?.code) ||
        [401, 403, 404].includes(error?.status)
      ) {
        escalate(session, "github_permission_missing", shortMessage(error));
        return;
      }
      session.pollFailures = (session.pollFailures ?? 0) + 1;
      record(session, "poll_error", shortMessage(error));
      schedulePoll(session);
      return;
    }
    if (stopped || !POLLED_STATES.has(session.state) || !status) return;
    session.pollFailures = 0;

    if (status.merged) {
      transition(session, "COMPLETED", "PR merged");
      return;
    }
    if (status.state === "closed") {
      transition(session, "SUPERSEDED", "PR closed without merging");
      return;
    }
    if (session.state === "WATCHING_CI") {
      if (status.headSha && status.headSha !== session.pr.head.sha) {
        escalate(
          session,
          "branch_changed_unexpectedly",
          `PR head is ${status.headSha}, Hands pushed ${session.pr.head.sha}`,
        );
        return;
      }
      const ciStatus = status.ci?.status;
      if (ciStatus === "none") {
        const pushedAt = Date.parse(session.pr.pushedAt ?? session.updatedAt);
        if (clock.now() - pushedAt >= NO_CHECKS_GRACE_MS) {
          clearPoll(session.id);
          transition(
            session,
            "READY_FOR_HUMAN_REVIEW",
            "no CI checks reported",
          );
          schedulePoll(session);
          return;
        }
      } else if (ciStatus === "success" || ciStatus === "failure") {
        await handleObservation({
          type: "ci",
          sessionId: session.id,
          headSha: session.pr.head.sha,
          status: ciStatus,
          failures: status.ci.failures,
        });
        return;
      }
    }
    schedulePoll(session);
  }

  function handleCiFailure(session, failures) {
    session.lastCiFailures = failures;
    const { autoFixCi, ciRepairBudget } = session.settings;
    if (classifyCiFailure(failures) === "infrastructure") {
      escalate(session, "ci_infrastructure_failure");
      return;
    }
    if (autoFixCi === "off") {
      escalate(session, "auto_fix_off");
      return;
    }
    const signature = failureSignature(failures);
    if (
      session.counters.ciRepairRounds > 0 &&
      signature === session.lastFailureSignature
    ) {
      escalate(session, "same_failure_repeated_without_progress");
      return;
    }
    if (session.counters.ciRepairRounds >= ciRepairBudget) {
      escalate(session, "ci_repair_budget_exhausted");
      return;
    }
    session.lastFailureSignature = signature;
    session.counters.ciRepairRounds += 1;
    transition(
      session,
      "REPAIRING_CI",
      `round ${session.counters.ciRepairRounds} of ${ciRepairBudget}`,
    );
    drive(session);
  }

  async function handleObservation(observation) {
    const session = sessions.get(observation?.sessionId);
    if (!session) return { error: { code: "session_not_found" } };
    if (stopped)
      return { ...snapshot(session), error: { code: "orchestrator_stopped" } };
    if (observation.type !== "ci") {
      return { ...snapshot(session), ignored: "unknown_observation" };
    }
    if (session.state !== "WATCHING_CI") {
      return { ...snapshot(session), ignored: "not_watching_ci" };
    }
    if (observation.headSha !== session.pr?.head.sha) {
      return { ...snapshot(session), ignored: "stale_head" };
    }
    if (observation.status === "success") {
      clearPoll(session.id);
      transition(session, "READY_FOR_HUMAN_REVIEW", "CI passed");
      schedulePoll(session);
    } else if (observation.status === "failure") {
      clearPoll(session.id);
      handleCiFailure(session, sanitizeFailures(observation.failures));
    }
    return snapshot(session);
  }

  return {
    getSettings: () => structuredClone(settings),

    updateSettings(patch) {
      settings = mergeSettings(settings, patch);
      store.saveSettings(settings);
      return structuredClone(settings);
    },

    listSessions: () =>
      [...sessions.values()]
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(snapshot),

    getSession(id) {
      const session = sessions.get(id);
      return session ? snapshot(session) : null;
    },

    async startSession(request) {
      assertRunning();
      const task = typeof request?.task === "string" ? request.task.trim() : "";
      if (!task || task.length > MAX_TASK_CHARS) {
        throw new HandsError(
          "invalid_task",
          "a task of 1-20000 characters is required",
        );
      }
      if (typeof request.repoDir !== "string" || !request.repoDir) {
        throw new HandsError("not_a_git_repository");
      }
      let repoDir;
      let baseBranch;
      try {
        repoDir = path.resolve(await git.topLevel(request.repoDir));
        baseBranch =
          typeof request.baseBranch === "string" && request.baseBranch
            ? request.baseBranch
            : await git.currentBranch(repoDir);
      } catch {
        throw new HandsError("not_a_git_repository");
      }
      if (
        !BRANCH_NAME_PATTERN.test(baseBranch ?? "") ||
        baseBranch.includes("..") ||
        baseBranch === "HEAD" ||
        baseBranch.startsWith("hands/")
      ) {
        throw new HandsError(
          "invalid_base_branch",
          "check out the branch Hands should start from",
        );
      }

      const id = createId();
      const now = new Date(clock.now()).toISOString();
      const session = {
        id,
        state: "PLANNING",
        request: { source: request.source ?? "chat", task, repoDir },
        linear:
          request.source === "linear" && request.linear
            ? {
                issueId: request.linear.issueId,
                identifier: request.linear.identifier,
                title: request.linear.title,
                url: request.linear.url,
                teamId: request.linear.teamId,
                teamKey: request.linear.teamKey,
                syncedAt: null,
                syncError: null,
                doneState: null,
              }
            : null,
        repoDir,
        baseBranch,
        branch: `hands/${id}`,
        worktreeDir: path.join(dataDir, "worktrees", id),
        worktreeCreated: false,
        settings: structuredClone(settings),
        plan: null,
        review: null,
        pendingApproval: null,
        pr: null,
        remoteUrl: null,
        counters: { reviewRounds: 0, ciRepairRounds: 0 },
        conversations: [],
        lastFailureSignature: null,
        escalation: null,
        failure: null,
        warnings: [],
        events: [],
        suspendedFrom: null,
        createdAt: now,
        updatedAt: now,
        finishedAt: null,
      };
      sessions.set(id, session);
      record(session, "state", "PLANNING");
      drive(session);
      return snapshot(session);
    },

    /**
     * Starts a session for a Linear issue, in the repository mapped to the
     * issue's team. The issue text is read from Linear, never from the caller.
     */
    async startFromLinear(issueId, overrides = {}) {
      assertRunning();
      if (!linear) throw new HandsError("linear_not_configured");
      if (typeof issueId !== "string" || !LINEAR_ID_PATTERN.test(issueId)) {
        throw new HandsError("invalid_linear_issue");
      }
      const activeFor = (id) =>
        [...sessions.values()].find(
          (session) =>
            session.linear?.issueId === id &&
            !TERMINAL_STATES.has(session.state),
        );
      const busy = (id) => {
        const active = activeFor(id);
        if (active || startingIssues.has(id)) {
          throw new HandsError(
            "linear_issue_in_progress",
            "this Linear issue already has an active session",
            { sessionId: active?.id ?? null },
          );
        }
      };
      busy(issueId);
      startingIssues.add(issueId);
      try {
        const issue = await linear.getIssue(issueId);
        if (issue.id !== issueId) busy(issue.id);
        const teamKey = issue.team?.key ?? "";
        const mapping = settings.linear?.teams?.[teamKey];
        const repoDir =
          (typeof overrides.repoDir === "string" && overrides.repoDir) ||
          mapping?.repoDir;
        if (!repoDir) {
          throw new HandsError(
            "linear_team_not_mapped",
            `choose a repository for Linear team ${teamKey}`,
            { teamKey },
          );
        }
        const heading = `${issue.identifier}: ${issue.title}`;
        const task = [heading, issue.description ?? ""]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, MAX_TASK_CHARS);
        return await this.startSession({
          source: "linear",
          task,
          repoDir,
          baseBranch:
            (typeof overrides.baseBranch === "string" &&
              overrides.baseBranch) ||
            mapping?.baseBranch ||
            undefined,
          linear: {
            issueId: issue.id,
            identifier: issue.identifier,
            title: issue.title,
            url: issue.url,
            teamId: issue.team?.id ?? null,
            teamKey,
          },
        });
      } finally {
        startingIssues.delete(issueId);
      }
    },

    /** The viewer's open Linear issues, each with its Hands session if any. */
    async linearInbox() {
      if (!linear) throw new HandsError("linear_not_configured");
      const issues = await linear.listAssignedIssues();
      const latest = new Map();
      for (const session of sessions.values()) {
        const issueId = session.linear?.issueId;
        if (!issueId) continue;
        const known = latest.get(issueId);
        const active = !TERMINAL_STATES.has(session.state);
        if (
          !known ||
          (active && TERMINAL_STATES.has(known.state)) ||
          (active === !TERMINAL_STATES.has(known.state) &&
            session.createdAt > known.createdAt)
        ) {
          latest.set(issueId, session);
        }
      }
      return {
        issues: issues.map((issue) => {
          const session = latest.get(issue.id);
          return {
            ...issue,
            description: String(issue.description ?? "").slice(0, 500),
            mapped: Boolean(settings.linear?.teams?.[issue.team?.key]?.repoDir),
            session: session ? { id: session.id, state: session.state } : null,
          };
        }),
      };
    },

    /** A Linear team's workflow states, for the Done mapping. */
    async linearTeamStates(teamId) {
      if (!linear) throw new HandsError("linear_not_configured");
      if (typeof teamId !== "string" || !LINEAR_ID_PATTERN.test(teamId)) {
        throw new HandsError("invalid_linear_team");
      }
      return { states: await linear.teamStates(teamId) };
    },

    /** Live check of each connection; never returns a token. */
    async connections() {
      const check = async (client, map) => {
        try {
          return { ok: true, ...map(await client.viewer()) };
        } catch (error) {
          return { ok: false, error: error?.code ?? "request_failed" };
        }
      };
      return {
        github: github.viewer
          ? await check(github, (viewer) => ({ account: viewer.login }))
          : { ok: false, error: "not_supported" },
        linear: linear
          ? await check(linear, (viewer) => ({ account: viewer.name }))
          : { ok: false, error: "linear_not_configured" },
      };
    },

    /** Committed changes on the session branch, against its base branch. */
    async sessionDiff(id) {
      const session = sessions.get(id);
      if (!session) throw new HandsError("session_not_found");
      const empty = {
        base: session.baseBranch,
        branch: session.branch,
        files: [],
        patch: "",
        truncated: false,
      };
      try {
        const files = await git.diffFiles(
          session.repoDir,
          session.baseBranch,
          session.branch,
        );
        const { patch, truncated } = await git.diffPatch(
          session.repoDir,
          session.baseBranch,
          session.branch,
        );
        return { ...empty, files, patch, truncated };
      } catch {
        // The branch does not exist yet (still planning) or was deleted.
        return empty;
      }
    },

    /** Retries moving a merged session's Linear issue to Done. */
    async syncLinear(id) {
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      if (session.state !== "COMPLETED" || !session.linear) {
        return {
          ...snapshot(session),
          error: { code: "linear_sync_not_ready" },
        };
      }
      await syncLinearDone(session);
      return snapshot(session);
    },

    async approve(id, gate) {
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      if (session.state !== "AWAITING_APPROVAL") {
        return {
          ...snapshot(session),
          error: { code: "not_awaiting_approval" },
        };
      }
      if (gate !== session.pendingApproval) {
        return {
          ...snapshot(session),
          error: {
            code: "approval_gate_mismatch",
            expected: session.pendingApproval,
          },
        };
      }
      assertRunning();
      session.pendingApproval = null;
      transition(session, GATE_NEXT_STATE[gate], `approved ${gate}`);
      drive(session);
      return snapshot(session);
    },

    async cancel(id) {
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      if (TERMINAL_STATES.has(session.state)) {
        return { ...snapshot(session), error: { code: "session_finished" } };
      }
      inflight.get(id)?.controller.abort(new HandsError("cancelled"));
      session.pendingApproval = null;
      transition(session, "CANCELLED", "cancelled by the user");
      return snapshot(session);
    },

    /** Continues a suspended session from the state it was suspended in. */
    async resume(id) {
      assertRunning();
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      if (session.state !== "SUSPENDED" || !session.suspendedFrom) {
        return { ...snapshot(session), error: { code: "not_suspended" } };
      }
      const state = session.suspendedFrom;
      session.suspendedFrom = null;
      transition(session, state, "resumed");
      if (RUNNING_STATES.has(state)) drive(session);
      else schedulePoll(session, 0);
      return snapshot(session);
    },

    /** Runs a failed session's failed stage again (the "Retry" action). */
    async retry(id) {
      assertRunning();
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      if (
        session.state !== "FAILED" ||
        !RUNNING_STATES.has(session.failure?.stage)
      ) {
        return { ...snapshot(session), error: { code: "not_failed" } };
      }
      const stage = session.failure.stage;
      session.failure = null;
      session.finishedAt = null;
      transition(session, stage, "retry");
      drive(session);
      return snapshot(session);
    },

    /**
     * On app start: sessions that were only waiting (for an approval, CI or a
     * merge) resume at once and recheck GitHub; sessions that were mid-stage
     * stay suspended until the user resumes them.
     */
    resumeWaiting() {
      for (const session of sessions.values()) {
        if (
          session.state === "SUSPENDED" &&
          session.suspendedFrom &&
          !RUNNING_STATES.has(session.suspendedFrom)
        ) {
          const state = session.suspendedFrom;
          session.suspendedFrom = null;
          transition(session, state, "resumed after restart");
          schedulePoll(session, 0);
        }
      }
    },

    /** Manual "Refresh now": polls GitHub for this session immediately. */
    refresh(id) {
      const session = sessions.get(id);
      if (!session) return { error: { code: "session_not_found" } };
      schedulePoll(session, 0);
      return snapshot(session);
    },

    /**
     * App shutdown: suspends every open session, aborts running stages and
     * clears all timers, then waits for in-flight work to settle.
     */
    async stop() {
      if (stopped) return;
      stopped = true;
      for (const handle of timers.values()) clock.clearTimeout(handle);
      timers.clear();
      for (const session of sessions.values()) {
        if (
          TERMINAL_STATES.has(session.state) ||
          session.state === "SUSPENDED"
        ) {
          continue;
        }
        session.suspendedFrom = session.state;
        session.state = "SUSPENDED";
        record(
          session,
          "state",
          `SUSPENDED: app closed during ${session.suspendedFrom}`,
        );
      }
      for (const entry of inflight.values()) {
        entry.controller.abort(new HandsError("orchestrator_stopped"));
      }
      while (inflight.size > 0 || polls.size > 0) {
        await Promise.allSettled([
          ...[...inflight.values()].map((entry) => entry.promise),
          ...polls,
        ]);
      }
      persist();
    },

    handleObservation,

    async waitIdle() {
      while (inflight.size > 0 || polls.size > 0) {
        await Promise.allSettled([
          ...[...inflight.values()].map((entry) => entry.promise),
          ...polls,
        ]);
      }
    },
  };
}
