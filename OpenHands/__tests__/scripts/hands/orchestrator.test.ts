// @vitest-environment node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createGit } from "../../../scripts/hands/git.mjs";
import { createOrchestrator } from "../../../scripts/hands/orchestrator.mjs";

type Role = "planner" | "coder" | "reviewer";
type AgentCall = {
  role: Role;
  sessionId: string;
  cwd: string;
  prompt: string;
  signal: AbortSignal;
  mode?: string;
  profileId?: string | null;
};
type Handler = (call: AgentCall) => Promise<{
  output: string;
  blocked?: Array<{ action: string; reason: string }>;
}>;

const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone with one commit on `main`, pushed to a bare remote next to it. */
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), "hands-orch-"));
  cleanups.push(root);
  const remote = path.join(root, "remote.git");
  const dir = path.join(root, "work");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", dir);
  git(dir, "config", "core.autocrlf", "false");
  writeFileSync(path.join(dir, "README.md"), "# demo\n");
  git(dir, "add", "README.md");
  git(
    dir,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@t",
    "commit",
    "-qm",
    "init",
  );
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main");
  return { root, remote, dir };
}

function fakeAgent(overrides: Partial<Record<Role, Handler>> = {}) {
  const calls: AgentCall[] = [];
  const callsFor = (role: Role) => calls.filter((call) => call.role === role);
  const defaults: Record<Role, Handler> = {
    planner: async () => ({ output: "1. Add hello.txt" }),
    coder: async ({ cwd }) => {
      writeFileSync(
        path.join(cwd, "hello.txt"),
        `round ${callsFor("coder").length}\n`,
      );
      return { output: "Wrote hello.txt" };
    },
    reviewer: async () => ({ output: "Looks right.\nVERDICT: APPROVE" }),
  };
  return {
    calls,
    callsFor,
    run: vi.fn(async (call: AgentCall) => {
      calls.push(call);
      return (overrides[call.role] ?? defaults[call.role])(call);
    }),
  };
}

function fakeGithub() {
  return {
    createPull: vi.fn(async () => ({
      number: 7,
      url: "https://github.com/acme/demo/pull/7",
    })),
  };
}

/** A clock whose timers only fire when the test says so. */
function fakeClock() {
  const pending = new Map<number, () => void>();
  let next = 0;
  let offset = 0;
  return {
    pending,
    advance: (ms: number) => {
      offset += ms;
    },
    now: () => Date.now() + offset,
    setTimeout: (fn: () => void) => {
      next += 1;
      pending.set(next, fn);
      return next;
    },
    clearTimeout: (handle: number) => {
      pending.delete(handle);
    },
    fireAll() {
      const due = [...pending.values()];
      pending.clear();
      for (const fn of due) fn();
    },
  };
}

function setup(
  options: {
    settings?: Record<string, unknown>;
    agent?: Partial<Record<Role, Handler>>;
    github?: Record<string, unknown>;
    clock?: ReturnType<typeof fakeClock>;
    linear?: Record<string, unknown>;
    gitOverrides?: Record<string, unknown>;
  } = {},
) {
  const repo = makeRepo();
  const agent = fakeAgent(options.agent);
  const github = { ...fakeGithub(), ...options.github };
  const onEvent = vi.fn();
  const dataDir = path.join(repo.root, "data");
  const create = () =>
    createOrchestrator({
      agent,
      github,
      dataDir,
      settings: options.settings,
      onEvent,
      clock: options.clock,
      linear: options.linear as never,
      ...(options.gitOverrides
        ? { git: { ...createGit(), ...options.gitOverrides } as never }
        : {}),
    });
  const orch = create();
  return { repo, agent, github, onEvent, dataDir, orch, create };
}

/** A planner that answers only when released, and records its abort signal. */
function blockingPlanner() {
  let release: (() => void) | undefined;
  const handler: Handler = ({ signal }) =>
    new Promise((resolve, reject) => {
      release = () => resolve({ output: "late plan" });
      signal.addEventListener("abort", () => reject(signal.reason));
    });
  return { handler, release: () => release?.() };
}

const finishedEvents = (h: ReturnType<typeof setup>) =>
  h.onEvent.mock.calls.filter(([event]) => event.type === "session_finished");

const chatRequest = (repoDir: string, task: string) => ({
  source: "chat",
  repoDir,
  task,
});

const NO_GATES = { gates: { approve_plan: false, open_pr: false } };

const ciSuccess = (sessionId: string, headSha: string) => ({
  type: "ci",
  sessionId,
  headSha,
  status: "success",
});

const ciFailure = (
  sessionId: string,
  headSha: string,
  failures = [
    {
      name: "unit-tests",
      conclusion: "failure",
      summary: "FAIL src/hello.test.ts > greets\nExpected 'hi' to be 'hello'",
    },
  ],
) => ({ type: "ci", sessionId, headSha, status: "failure", failures });

/** Starts a session with no approval gates and waits until its PR is open. */
async function toWatchingCi(h: ReturnType<typeof setup>) {
  const started = await h.orch.startSession(
    chatRequest(h.repo.dir, "Add a hello file"),
  );
  await h.orch.waitIdle();
  const session = h.orch.getSession(started.id)!;
  expect(session.state).toBe("WATCHING_CI");
  return session;
}

const remoteHead = (h: ReturnType<typeof setup>, branch: string) =>
  git(h.repo.remote, "rev-parse", `refs/heads/${branch}`);

describe("orchestrator", () => {
  it("plans, codes, reviews and opens a PR only after each approval, then goes green", async () => {
    const h = setup();

    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    expect(session.state).toBe("PLANNING");
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "AWAITING_APPROVAL",
      pendingApproval: "approve_plan",
      plan: "1. Add hello.txt",
    });
    expect(h.agent.callsFor("coder")).toHaveLength(0);

    await h.orch.approve(session.id, "approve_plan");
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "AWAITING_APPROVAL",
      pendingApproval: "open_pr",
    });
    expect(h.agent.callsFor("coder")).toHaveLength(1);
    expect(h.agent.callsFor("reviewer")).toHaveLength(1);
    expect(h.github.createPull).not.toHaveBeenCalled();

    await h.orch.approve(session.id, "open_pr");
    await h.orch.waitIdle();
    const watching = h.orch.getSession(session.id)!;
    expect(watching.state).toBe("WATCHING_CI");
    expect(watching.pr).toMatchObject({
      number: 7,
      head: { ref: watching.branch },
    });
    expect(
      git(h.repo.remote, "rev-parse", `refs/heads/${watching.branch}`),
    ).toBe(watching.pr!.head.sha);
    expect(h.github.createPull).toHaveBeenCalledWith(
      expect.objectContaining({ head: watching.branch, base: "main" }),
    );
    // The user's own checkout is never touched.
    expect(git(h.repo.dir, "status", "--porcelain")).toBe("");
    expect(git(h.repo.dir, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");

    await h.orch.handleObservation({
      type: "ci",
      sessionId: session.id,
      headSha: watching.pr!.head.sha,
      status: "success",
    });
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");
  });

  it("refuses an approval for a gate the session is not waiting on", async () => {
    const h = setup();
    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await h.orch.waitIdle();

    const refused = await h.orch.approve(session.id, "push_fix");

    expect(refused.state).toBe("AWAITING_APPROVAL");
    expect(refused.error).toEqual(
      expect.objectContaining({
        code: "approval_gate_mismatch",
        expected: "approve_plan",
      }),
    );
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)!.state).toBe("AWAITING_APPROVAL");
    expect(h.agent.callsFor("coder")).toHaveLength(0);
    expect(h.github.createPull).not.toHaveBeenCalled();
  });

  it("repairs a CI failure on the app-owned PR, pushes the fix only after approval, then goes green", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "local" } });
    const session = await toWatchingCi(h);
    const firstSha = session.pr!.head.sha;

    await h.orch.handleObservation(ciFailure(session.id, firstSha));
    await h.orch.waitIdle();

    const fixed = h.orch.getSession(session.id)!;
    expect(fixed).toMatchObject({
      state: "AWAITING_APPROVAL",
      pendingApproval: "push_fix",
      counters: { ciRepairRounds: 1 },
    });
    expect(h.agent.callsFor("coder")).toHaveLength(2);
    expect(h.agent.callsFor("coder")[1].prompt).toContain(
      "Expected 'hi' to be 'hello'",
    );
    // The fix was reviewed again before it may be pushed.
    expect(h.agent.callsFor("reviewer")).toHaveLength(2);
    expect(remoteHead(h, session.branch)).toBe(firstSha);

    await h.orch.approve(session.id, "push_fix");
    await h.orch.waitIdle();
    const watching = h.orch.getSession(session.id)!;
    expect(watching.state).toBe("WATCHING_CI");
    expect(watching.pr!.head.sha).not.toBe(firstSha);
    expect(remoteHead(h, session.branch)).toBe(watching.pr!.head.sha);
    expect(h.github.createPull).toHaveBeenCalledTimes(1);

    await h.orch.handleObservation(
      ciSuccess(session.id, watching.pr!.head.sha),
    );
    expect(h.orch.getSession(session.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");
  });

  it("masks credentials in CI logs before they reach the coder", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "local" } });
    const session = await toWatchingCi(h);
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

    await h.orch.handleObservation(
      ciFailure(session.id, session.pr!.head.sha, [
        {
          name: "deploy-preview",
          conclusion: "failure",
          summary: `Error: push refused for token=${token}\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz012345\napi_key: sk-live-abcdef123456`,
        },
      ]),
    );
    await h.orch.waitIdle();

    const prompt = h.agent.callsFor("coder")[1].prompt;
    expect(prompt).toContain("push refused");
    expect(prompt).not.toContain(token);
    expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
    expect(prompt).not.toContain("sk-live-abcdef123456");
  });

  it("pushes a reviewed fix without asking in update_pr mode", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "update_pr" } });
    const session = await toWatchingCi(h);

    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();

    const watching = h.orch.getSession(session.id)!;
    expect(watching.state).toBe("WATCHING_CI");
    expect(remoteHead(h, session.branch)).toBe(watching.pr!.head.sha);
    expect(watching.pr!.head.sha).not.toBe(session.pr!.head.sha);
  });

  it("escalates an infrastructure failure without calling the coder", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "update_pr" } });
    const session = await toWatchingCi(h);

    await h.orch.handleObservation(
      ciFailure(session.id, session.pr!.head.sha, [
        {
          name: "build",
          conclusion: "failure",
          summary:
            "The runner has received a shutdown signal. The operation was canceled.",
        },
      ]),
    );
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "ci_infrastructure_failure" },
    });
    expect(h.agent.callsFor("coder")).toHaveLength(1);
  });

  it("escalates when the same CI failure signature comes back after a repair", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "update_pr" } });
    const session = await toWatchingCi(h);
    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();
    const repaired = h.orch.getSession(session.id)!;
    expect(repaired.counters.ciRepairRounds).toBe(1);

    // Same job, same error; only the line numbers and timing changed.
    await h.orch.handleObservation(
      ciFailure(session.id, repaired.pr!.head.sha, [
        {
          name: "unit-tests",
          conclusion: "failure",
          summary:
            "FAIL src/hello.test.ts > greets\nExpected 'hi' to be 'hello'",
        },
      ]),
    );
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "same_failure_repeated_without_progress" },
    });
    expect(h.agent.callsFor("coder")).toHaveLength(2);
  });

  it("stops repairing when the CI repair budget is used up", async () => {
    const h = setup({
      settings: { ...NO_GATES, autoFixCi: "update_pr", ciRepairBudget: 1 },
    });
    const session = await toWatchingCi(h);
    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();

    await h.orch.handleObservation(
      ciFailure(session.id, h.orch.getSession(session.id)!.pr!.head.sha, [
        {
          name: "lint",
          conclusion: "failure",
          summary: "error: unused import",
        },
      ]),
    );
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "ci_repair_budget_exhausted" },
    });
    expect(h.agent.callsFor("coder")).toHaveLength(2);
  });

  it("escalates with ci_fix_failed when the coder cannot produce a fix", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "update_pr" } });
    const session = await toWatchingCi(h);
    h.agent.run.mockImplementationOnce(async (call: AgentCall) => {
      h.agent.calls.push(call);
      return { output: "I could not find the cause." };
    });

    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "ci_fix_failed" },
    });
    expect(remoteHead(h, session.branch)).toBe(session.pr!.head.sha);
  });

  it("only reports the failure when auto-fix is off", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "off" } });
    const session = await toWatchingCi(h);

    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "auto_fix_off" },
      lastCiFailures: [expect.objectContaining({ name: "unit-tests" })],
    });
    expect(h.agent.callsFor("coder")).toHaveLength(1);
  });

  it("suggests a fix without keeping any edit in suggest mode", async () => {
    const h = setup({
      settings: { ...NO_GATES, autoFixCi: "suggest" },
      agent: {
        coder: async ({ cwd, prompt }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "edited anyway\n");
          return {
            output: prompt.includes("<ci_failure>")
              ? "Change the greeting to 'hello'."
              : "Wrote hello.txt",
          };
        },
      },
    });
    const session = await toWatchingCi(h);

    await h.orch.handleObservation(ciFailure(session.id, session.pr!.head.sha));
    await h.orch.waitIdle();

    const suggested = h.orch.getSession(session.id)!;
    expect(suggested).toMatchObject({
      state: "ESCALATED",
      escalation: {
        reason: "fix_suggested",
        detail: "Change the greeting to 'hello'.",
      },
    });
    expect(h.agent.callsFor("coder")[1].mode).toBe("suggest");
    expect(git(suggested.worktreeDir, "status", "--porcelain")).toBe("");
    expect(remoteHead(h, session.branch)).toBe(session.pr!.head.sha);
  });

  it("ignores a CI result for a commit that is no longer the PR head", async () => {
    const h = setup({ settings: { ...NO_GATES, autoFixCi: "update_pr" } });
    const session = await toWatchingCi(h);

    const result = await h.orch.handleObservation(
      ciFailure(session.id, "0".repeat(40)),
    );

    expect(result.ignored).toBe("stale_head");
    expect(h.orch.getSession(session.id)!.state).toBe("WATCHING_CI");
    expect(h.agent.callsFor("coder")).toHaveLength(1);
  });

  it("reverts files a reviewer changed and records a warning", async () => {
    const h = setup({
      settings: NO_GATES,
      agent: {
        reviewer: async ({ cwd }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "reviewer rewrote this\n");
          writeFileSync(path.join(cwd, "notes.md"), "scratch\n");
          return { output: "Fine.\nVERDICT: APPROVE" };
        },
      },
    });

    const session = await toWatchingCi(h);

    expect(session.warnings).toEqual([
      expect.objectContaining({
        code: "reviewer_changed_files",
        files: expect.arrayContaining(["hello.txt", "notes.md"]),
      }),
    ]);
    expect(git(session.worktreeDir, "status", "--porcelain")).toBe("");
    expect(
      git(h.repo.remote, "show", `${session.pr!.head.sha}:hello.txt`),
    ).toBe("round 1");
  });

  it("cancel stops the in-flight planner and finishes the session once", async () => {
    let answerLate: (() => void) | undefined;
    const h = setup({
      agent: {
        // Ignores the abort and answers anyway, like a slow remote agent.
        planner: () =>
          new Promise((resolve) => {
            answerLate = () => resolve({ output: "late plan" });
          }),
      },
    });
    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await vi.waitFor(() => expect(h.agent.callsFor("planner")).toHaveLength(1));

    const cancelled = await h.orch.cancel(session.id);
    expect(cancelled.state).toBe("CANCELLED");
    expect(h.agent.callsFor("planner")[0].signal.aborted).toBe(true);

    answerLate!();
    await h.orch.waitIdle();
    await h.orch.cancel(session.id);

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "CANCELLED",
      plan: null,
    });
    expect(finishedEvents(h)).toHaveLength(1);
  });

  it("stop() suspends open sessions, aborts stages and leaves no timers behind", async () => {
    const clock = fakeClock();
    const blocked = blockingPlanner();
    let plannerRuns = 0;
    const h = setup({
      settings: NO_GATES,
      clock,
      github: {
        getPullStatus: vi.fn(async () => ({
          state: "open",
          merged: false,
          ci: { status: "pending" },
        })),
      },
      agent: {
        planner: async (call) => {
          plannerRuns += 1;
          return plannerRuns === 1
            ? { output: "1. Add hello.txt" }
            : blocked.handler(call);
        },
      },
    });
    const watching = await toWatchingCi(h);
    expect(clock.pending.size).toBe(1);
    const planning = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a second file"),
    );
    await vi.waitFor(() => expect(h.agent.callsFor("planner")).toHaveLength(2));

    await h.orch.stop();

    expect(h.orch.getSession(watching.id)).toMatchObject({
      state: "SUSPENDED",
      suspendedFrom: "WATCHING_CI",
    });
    expect(h.orch.getSession(planning.id)).toMatchObject({
      state: "SUSPENDED",
      suspendedFrom: "PLANNING",
    });
    expect(h.agent.callsFor("planner")[1].signal.aborted).toBe(true);
    expect(clock.pending.size).toBe(0);
    expect(finishedEvents(h)).toHaveLength(0);
    await expect(
      h.orch.startSession(chatRequest(h.repo.dir, "One more")),
    ).rejects.toMatchObject({ code: "orchestrator_stopped" });
  });

  it("restores sessions after a restart, rechecks waiting ones and resumes the rest on request", async () => {
    const clock = fakeClock();
    const blocked = blockingPlanner();
    const getPullStatus = vi.fn(async () => ({
      state: "open",
      merged: false,
      ci: { status: "pending" },
    }));
    let plannerRuns = 0;
    const h = setup({
      settings: NO_GATES,
      clock,
      github: { getPullStatus },
      agent: {
        planner: async (call) => {
          plannerRuns += 1;
          return plannerRuns === 2
            ? blocked.handler(call)
            : { output: "1. Add hello.txt" };
        },
      },
    });
    const watching = await toWatchingCi(h);
    const crashed = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a second file"),
    );
    await vi.waitFor(() => expect(plannerRuns).toBe(2));

    // A second process opens the same data while the first is still mid-stage,
    // exactly what it finds after a crash.
    const reopened = h.create();
    expect(reopened.getSession(crashed.id)).toMatchObject({
      state: "SUSPENDED",
      suspendedFrom: "PLANNING",
    });
    await h.orch.stop();

    const afterStop = h.create();
    afterStop.resumeWaiting();
    expect(afterStop.getSession(watching.id)!.state).toBe("WATCHING_CI");
    expect(afterStop.getSession(crashed.id)!.state).toBe("SUSPENDED");
    clock.fireAll();
    await afterStop.waitIdle();
    expect(getPullStatus).toHaveBeenCalledWith(
      expect.objectContaining({ number: 7 }),
    );

    await afterStop.resume(crashed.id);
    await afterStop.waitIdle();
    expect(afterStop.getSession(crashed.id)!.state).toBe("WATCHING_CI");
    await afterStop.stop();
  });

  it("polls the PR, repairs on a failed run and completes only on a real merge", async () => {
    const clock = fakeClock();
    const statuses: unknown[] = [];
    const getPullStatus = vi.fn(async () => statuses.shift());
    const h = setup({
      settings: { ...NO_GATES, autoFixCi: "update_pr" },
      clock,
      github: { getPullStatus },
    });
    const session = await toWatchingCi(h);
    const poll = async () => {
      clock.fireAll();
      await h.orch.waitIdle();
    };

    statuses.push({
      state: "open",
      merged: false,
      headSha: session.pr!.head.sha,
      ci: { status: "pending" },
    });
    await poll();
    expect(h.orch.getSession(session.id)!.state).toBe("WATCHING_CI");

    statuses.push({
      state: "open",
      merged: false,
      headSha: session.pr!.head.sha,
      ci: {
        status: "failure",
        failures: [
          { name: "unit-tests", conclusion: "failure", summary: "FAIL greets" },
        ],
      },
    });
    await poll();
    const repaired = h.orch.getSession(session.id)!;
    expect(repaired.state).toBe("WATCHING_CI");
    expect(repaired.counters.ciRepairRounds).toBe(1);

    statuses.push({
      state: "open",
      merged: false,
      headSha: repaired.pr!.head.sha,
      ci: { status: "success" },
    });
    await poll();
    expect(h.orch.getSession(session.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");

    statuses.push({
      state: "open",
      merged: false,
      headSha: repaired.pr!.head.sha,
      ci: { status: "success" },
    });
    await poll();
    expect(h.orch.getSession(session.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");

    statuses.push({
      state: "closed",
      merged: true,
      headSha: repaired.pr!.head.sha,
      ci: { status: "success" },
    });
    await poll();
    expect(h.orch.getSession(session.id)!.state).toBe("COMPLETED");
    expect(clock.pending.size).toBe(0);
    expect(finishedEvents(h)).toHaveLength(1);
  });

  it("keeps watching through a failed GitHub poll and backs off", async () => {
    const clock = fakeClock();
    const getPullStatus = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("GitHub API rate limit reached"), {
          code: "github_rate_limited",
        }),
      )
      .mockResolvedValueOnce({
        state: "open",
        merged: false,
        ci: { status: "success" },
      });
    const h = setup({ settings: NO_GATES, clock, github: { getPullStatus } });
    const session = await toWatchingCi(h);

    clock.fireAll();
    await h.orch.waitIdle();
    const afterError = h.orch.getSession(session.id)!;
    expect(afterError.state).toBe("WATCHING_CI");
    expect(afterError.events.at(-1)).toMatchObject({
      type: "poll_error",
      message: "GitHub API rate limit reached",
    });
    expect(clock.pending.size).toBe(1);

    clock.fireAll();
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");
  });

  it("treats a repository without CI checks as passed only after a grace period", async () => {
    const clock = fakeClock();
    const h = setup({
      settings: NO_GATES,
      clock,
      github: {
        getPullStatus: vi.fn(async () => ({
          state: "open",
          merged: false,
          ci: { status: "none" },
        })),
      },
    });
    const session = await toWatchingCi(h);

    // Checks may simply not have started yet right after the push.
    clock.fireAll();
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)!.state).toBe("WATCHING_CI");

    clock.advance(6 * 60_000);
    clock.fireAll();
    await h.orch.waitIdle();
    const ready = h.orch.getSession(session.id)!;
    expect(ready.state).toBe("READY_FOR_HUMAN_REVIEW");
    expect(ready.events.at(-1)!.message).toContain("no CI checks");
  });

  it("marks a PR closed without merging as superseded and a foreign push as escalated", async () => {
    const clock = fakeClock();
    const statuses: unknown[] = [];
    const h = setup({
      settings: NO_GATES,
      clock,
      github: { getPullStatus: vi.fn(async () => statuses.shift()) },
    });
    const closed = await toWatchingCi(h);
    statuses.push({
      state: "closed",
      merged: false,
      ci: { status: "pending" },
    });
    clock.fireAll();
    await h.orch.waitIdle();
    expect(h.orch.getSession(closed.id)!.state).toBe("SUPERSEDED");

    const pushed = await toWatchingCi(h);
    statuses.push({
      state: "open",
      merged: false,
      headSha: "f".repeat(40),
      ci: { status: "failure", failures: [] },
    });
    clock.fireAll();
    await h.orch.waitIdle();
    expect(h.orch.getSession(pushed.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "branch_changed_unexpectedly" },
    });
    expect(h.agent.callsFor("coder")).toHaveLength(2);
  });

  it("retries a failed session from the stage that failed", async () => {
    let coderRuns = 0;
    const h = setup({
      settings: { ...NO_GATES, roles: { coder: "profile-coder" } },
      agent: {
        coder: async ({ cwd }) => {
          coderRuns += 1;
          if (coderRuns === 1) throw new Error("agent-server unreachable");
          writeFileSync(path.join(cwd, "hello.txt"), "hello\n");
          return { output: "Wrote hello.txt" };
        },
      },
    });
    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await h.orch.waitIdle();
    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "FAILED",
      failure: { stage: "CODING", message: "agent-server unreachable" },
    });
    expect(h.agent.callsFor("coder")[0]).toMatchObject({
      profileId: "profile-coder",
    });

    expect((await h.orch.retry(session.id)).state).toBe("CODING");
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "WATCHING_CI",
      failure: null,
      finishedAt: null,
    });
    expect((await h.orch.retry(session.id)).error).toMatchObject({
      code: "not_failed",
    });
  });

  it("validates settings, keeps them across restarts and snapshots them per session", async () => {
    const h = setup();

    expect(() => h.orch.updateSettings({ ciRepairBudget: 99 })).toThrow(
      expect.objectContaining({
        code: "invalid_settings",
        field: "ciRepairBudget",
      }),
    );
    const before = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await h.orch.waitIdle();
    h.orch.updateSettings({ autoFixCi: "off", ciRepairBudget: 1 });

    expect(h.orch.getSession(before.id)!.settings).toMatchObject({
      autoFixCi: "local",
      ciRepairBudget: 3,
    });
    expect(h.create().getSettings()).toMatchObject({
      autoFixCi: "off",
      ciRepairBudget: 1,
    });
  });

  it("never stores or shares credentials embedded in the remote URL", async () => {
    const h = setup({ settings: NO_GATES });
    git(
      h.repo.dir,
      "remote",
      "set-url",
      "origin",
      "https://x-token:s3cr3t-value@github.com/acme/demo.git",
    );
    // Pushes still reach the local bare remote.
    git(h.repo.dir, "remote", "set-url", "--push", "origin", h.repo.remote);

    const session = await toWatchingCi(h);

    expect(session.remoteUrl).toBe("https://github.com/acme/demo.git");
    expect(h.github.createPull).toHaveBeenCalledWith(
      expect.objectContaining({
        remoteUrl: "https://github.com/acme/demo.git",
      }),
    );
    expect(
      readFileSync(path.join(h.dataDir, "sessions.json"), "utf8"),
    ).not.toContain("s3cr3t-value");
  });

  it("keeps credentials out of a failed stage's message", async () => {
    const h = setup({
      settings: NO_GATES,
      agent: {
        coder: async () => {
          throw new Error(
            "fatal: unable to access 'https://bot:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/acme/demo.git/'",
          );
        },
      },
    });
    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await h.orch.waitIdle();

    const failed = h.orch.getSession(session.id)!;
    expect(failed.state).toBe("FAILED");
    expect(failed.failure!.message).toContain("unable to access");
    expect(JSON.stringify(failed)).not.toContain(
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
  });

  it("refuses a base branch that git could read as an option", async () => {
    const h = setup();

    for (const baseBranch of ["--detach", "-f", "main..evil", "hands/abc"]) {
      await expect(
        h.orch.startSession({
          ...chatRequest(h.repo.dir, "Add a file"),
          baseBranch,
        }),
      ).rejects.toMatchObject({ code: "invalid_base_branch" });
    }
    expect(h.orch.listSessions()).toEqual([]);
    // A normal nested branch name still works.
    git(h.repo.dir, "branch", "release/1.2");
    const ok = await h.orch.startSession({
      ...chatRequest(h.repo.dir, "Add a file"),
      baseBranch: "release/1.2",
    });
    expect(ok.baseBranch).toBe("release/1.2");
    await h.orch.waitIdle();
  });

  it("resumes a session whose process died right after creating its worktree", async () => {
    const blocked = blockingPlanner();
    let runs = 0;
    const h = setup({
      settings: NO_GATES,
      agent: {
        planner: async (call) => {
          runs += 1;
          return runs === 1
            ? blocked.handler(call)
            : { output: "1. Add hello.txt" };
        },
      },
    });
    const session = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await vi.waitFor(() => expect(runs).toBe(1));

    const reopened = h.create();
    await reopened.resume(session.id);
    await reopened.waitIdle();

    expect(reopened.getSession(session.id)!.state).toBe("WATCHING_CI");
    await h.orch.stop();
    await reopened.stop();
  });

  it("records the agent actions the command guard blocked", async () => {
    const h = setup({
      settings: NO_GATES,
      agent: {
        coder: async ({ cwd }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "hello\n");
          return {
            output: "done",
            blocked: [
              {
                action:
                  "sudo apt install jq token=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
                reason: "running commands as another user is not allowed.",
              },
            ],
          };
        },
      },
    });

    const session = await toWatchingCi(h);

    expect(session.warnings).toContainEqual(
      expect.objectContaining({
        code: "commands_blocked",
        role: "coder",
        actions: [
          {
            action: expect.not.stringContaining("ghp_abcdef"),
            reason: "running commands as another user is not allowed.",
          },
        ],
      }),
    );
    expect(
      session.events.map((event: { message: string }) => event.message),
    ).toContainEqual(expect.stringMatching(/blocked/));
  });

  it("never commits secret-looking files the coder leaves behind", async () => {
    const h = setup({
      settings: NO_GATES,
      agent: {
        coder: async ({ cwd }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "hello\n");
          writeFileSync(path.join(cwd, ".env"), "API_KEY=abc123\n");
          writeFileSync(path.join(cwd, "deploy.pem"), "-----BEGIN-----\n");
          return { output: "done" };
        },
      },
    });

    const session = await toWatchingCi(h);

    const pushed = git(
      h.repo.remote,
      "ls-tree",
      "-r",
      "--name-only",
      session.pr!.head.sha,
    );
    expect(pushed.split("\n")).toEqual(expect.arrayContaining(["hello.txt"]));
    expect(pushed).not.toMatch(/\.env|deploy\.pem/);
    expect(session.warnings).toContainEqual(
      expect.objectContaining({
        code: "secret_files_skipped",
        files: expect.arrayContaining([".env", "deploy.pem"]),
      }),
    );
  });

  it("stops an agent's own git push while Hands can still push its branch", async () => {
    let agentPush: unknown = "not attempted";
    const h = setup({
      settings: NO_GATES,
      agent: {
        coder: async ({ cwd }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "hello\n");
          try {
            execFileSync(
              "git",
              ["push", "-q", "origin", "HEAD:refs/heads/main", "--force"],
              {
                cwd,
                stdio: "pipe",
              },
            );
            agentPush = "pushed";
          } catch {
            agentPush = "refused";
          }
          return { output: "done" };
        },
      },
    });
    const mainBefore = git(h.repo.remote, "rev-parse", "refs/heads/main");

    const session = await toWatchingCi(h);

    expect(agentPush).toBe("refused");
    expect(git(h.repo.remote, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    expect(remoteHead(h, session.branch)).toBe(session.pr!.head.sha);
  });

  it("refuses an agent push to an ad-hoc URL that no remote names", async () => {
    let agentPush: unknown = "not attempted";
    const other = mkdtempSync(path.join(tmpdir(), "hands-other-"));
    execFileSync("git", ["init", "-q", "--bare", other]);
    const h = setup({
      settings: NO_GATES,
      agent: {
        coder: async ({ cwd }) => {
          writeFileSync(path.join(cwd, "hello.txt"), "hello\n");
          try {
            execFileSync(
              "git",
              ["push", "-q", other, "HEAD:refs/heads/stolen"],
              {
                cwd,
                stdio: "pipe",
              },
            );
            agentPush = "pushed";
          } catch {
            agentPush = "refused";
          }
          return { output: "done" };
        },
      },
    });

    await toWatchingCi(h);

    expect(agentPush).toBe("refused");
    expect(() =>
      git(other, "rev-parse", "--verify", "-q", "refs/heads/stolen"),
    ).toThrow();
    rmSync(other, { recursive: true, force: true });
  });

  it("escalates instead of retrying forever when GitHub refuses the token", async () => {
    const clock = fakeClock();
    const h = setup({
      settings: NO_GATES,
      clock,
      github: {
        getPullStatus: vi.fn(async () => {
          throw Object.assign(new Error("GitHub rejected the token"), {
            code: "github_token_invalid",
          });
        }),
      },
    });
    const session = await toWatchingCi(h);

    clock.fireAll();
    await h.orch.waitIdle();

    expect(h.orch.getSession(session.id)).toMatchObject({
      state: "ESCALATED",
      escalation: { reason: "github_permission_missing" },
    });
    expect(clock.pending.size).toBe(0);
  });

  it("keeps a corrupt sessions file aside instead of overwriting it", async () => {
    const h = setup();
    mkdirSync(h.dataDir, { recursive: true });
    writeFileSync(path.join(h.dataDir, "sessions.json"), "{not json");
    const reopened = h.create();

    await reopened.startSession(chatRequest(h.repo.dir, "Add a hello file"));
    await reopened.waitIdle();

    const kept = readdirSync(h.dataDir).filter((name) =>
      name.startsWith("sessions.json.corrupt-"),
    );
    expect(kept).toHaveLength(1);
    expect(readFileSync(path.join(h.dataDir, kept[0]), "utf8")).toBe(
      "{not json",
    );
  });

  it("masks secrets in agent output before storing it or putting it in the PR", async () => {
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const h = setup({
      settings: NO_GATES,
      agent: {
        planner: async () => ({
          output: `1. Use token ${token} to call the API`,
        }),
      },
    });

    const session = await toWatchingCi(h);

    expect(session.plan).toContain("Use token");
    expect(JSON.stringify(session)).not.toContain(token);
    expect(JSON.stringify(h.github.createPull.mock.calls)).not.toContain(token);
  });

  it("rejects a session on a folder that is not a git repository", async () => {
    const h = setup();
    const plain = mkdtempSync(path.join(tmpdir(), "hands-plain-"));
    cleanups.push(plain);

    await expect(
      h.orch.startSession(chatRequest(plain, "Add a hello file")),
    ).rejects.toMatchObject({ code: "not_a_git_repository" });
    expect(h.orch.listSessions()).toEqual([]);
  });
});

describe("orchestrator: Linear", () => {
  const issue = {
    id: "issue-1",
    identifier: "ENG-12",
    title: "Fix login",
    description: "Login fails on Safari",
    url: "https://linear.app/acme/issue/ENG-12",
    priority: 2,
    updatedAt: "2026-11-20T00:00:00.000Z",
    state: { id: "st-todo", name: "Todo", type: "unstarted" },
    team: { id: "team-1", key: "ENG", name: "Engineering" },
  };

  function fakeLinear(overrides: Record<string, unknown> = {}) {
    return {
      getIssue: vi.fn(async () => issue),
      teamStates: vi.fn(async () => [
        { id: "st-todo", name: "Todo", type: "unstarted" },
        { id: "st-shipped", name: "Shipped", type: "completed" },
      ]),
      moveIssue: vi.fn(async () => ({
        id: "st-done",
        name: "Done",
        type: "completed",
      })),
      ...overrides,
    };
  }

  type TeamMap = Record<
    string,
    { repo?: boolean; baseBranch?: string; doneStateId?: string | null }
  >;

  function linearSetup(teams: TeamMap, linear = fakeLinear()) {
    const clock = fakeClock();
    const statuses: unknown[] = [];
    const getPullStatus = vi.fn(async () => statuses.shift());
    const h = setup({
      settings: NO_GATES,
      clock,
      linear,
      github: { getPullStatus },
    });
    const mapped = Object.fromEntries(
      Object.entries(teams).map(([key, { repo, ...rest }]) => [
        key,
        { ...rest, repoDir: repo ? h.repo.dir : null },
      ]),
    );
    h.orch.updateSettings({ linear: { teams: mapped } });
    const poll = async () => {
      clock.fireAll();
      await h.orch.waitIdle();
    };
    return { h, linear, statuses, poll };
  }

  it("starts a session from an issue in the team's mapped repository", async () => {
    const { h } = linearSetup({ ENG: { repo: true } });

    const started = await h.orch.startFromLinear("issue-1");
    await h.orch.waitIdle();
    const session = h.orch.getSession(started.id)!;

    expect(session.request.source).toBe("linear");
    expect(session.request.task).toContain("ENG-12: Fix login");
    expect(session.request.task).toContain("Login fails on Safari");
    expect(session.linear).toMatchObject({
      issueId: "issue-1",
      identifier: "ENG-12",
      teamKey: "ENG",
      url: "https://linear.app/acme/issue/ENG-12",
      syncedAt: null,
    });
    expect(h.agent.callsFor("planner")[0].prompt).toContain(
      "ENG-12: Fix login",
    );
    const pull = (h.github.createPull as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(pull.title).toMatch(/^ENG-12: Fix login/);
    expect(pull.body).toContain("https://linear.app/acme/issue/ENG-12");
  });

  it("allows only one active session per issue", async () => {
    const { h } = linearSetup({ ENG: { repo: true } });
    const first = await h.orch.startFromLinear("issue-1");

    await expect(h.orch.startFromLinear("issue-1")).rejects.toMatchObject({
      code: "linear_issue_in_progress",
      sessionId: first.id,
    });
    await h.orch.waitIdle();
  });

  it("refuses an issue whose team has no repository mapped", async () => {
    const { h } = linearSetup({});

    await expect(h.orch.startFromLinear("issue-1")).rejects.toMatchObject({
      code: "linear_team_not_mapped",
      teamKey: "ENG",
    });
    expect(h.orch.listSessions()).toEqual([]);
  });

  it("moves the issue to the mapped Done state only after the real merge, once", async () => {
    const { h, linear, statuses, poll } = linearSetup({
      ENG: { repo: true, doneStateId: "st-done" },
    });
    const started = await h.orch.startFromLinear("issue-1");
    await h.orch.waitIdle();
    const sha = h.orch.getSession(started.id)!.pr!.head.sha;

    statuses.push({
      state: "open",
      merged: false,
      headSha: sha,
      ci: { status: "success" },
    });
    await poll();
    expect(h.orch.getSession(started.id)!.state).toBe("READY_FOR_HUMAN_REVIEW");
    expect(linear.moveIssue).not.toHaveBeenCalled();

    statuses.push({
      state: "closed",
      merged: true,
      headSha: sha,
      ci: { status: "success" },
    });
    await poll();
    const done = h.orch.getSession(started.id)!;
    expect(done.state).toBe("COMPLETED");
    expect(linear.moveIssue).toHaveBeenCalledTimes(1);
    expect(linear.moveIssue).toHaveBeenCalledWith("issue-1", "st-done");
    expect(done.linear.syncedAt).toEqual(expect.any(String));

    await h.orch.syncLinear(started.id);
    expect(linear.moveIssue).toHaveBeenCalledTimes(1);
  });

  it("uses the team's first completed state when no Done state is mapped", async () => {
    const { h, linear, statuses, poll } = linearSetup({ ENG: { repo: true } });
    const started = await h.orch.startFromLinear("issue-1");
    await h.orch.waitIdle();
    const sha = h.orch.getSession(started.id)!.pr!.head.sha;

    statuses.push({
      state: "closed",
      merged: true,
      headSha: sha,
      ci: { status: "success" },
    });
    await poll();

    expect(linear.moveIssue).toHaveBeenCalledWith("issue-1", "st-shipped");
  });

  it("never moves the issue when the PR is closed without merging", async () => {
    const { h, linear, statuses, poll } = linearSetup({ ENG: { repo: true } });
    const started = await h.orch.startFromLinear("issue-1");
    await h.orch.waitIdle();
    const sha = h.orch.getSession(started.id)!.pr!.head.sha;

    statuses.push({
      state: "closed",
      merged: false,
      headSha: sha,
      ci: { status: "success" },
    });
    await poll();

    expect(h.orch.getSession(started.id)!.state).toBe("SUPERSEDED");
    expect(linear.moveIssue).not.toHaveBeenCalled();
  });

  it("records a failed Linear update and succeeds on retry", async () => {
    const linear = fakeLinear({
      moveIssue: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Linear rate limit reached"), {
            code: "linear_rate_limited",
          }),
        )
        .mockResolvedValueOnce({
          id: "st-done",
          name: "Done",
          type: "completed",
        }),
    });
    const { h, statuses, poll } = linearSetup(
      { ENG: { repo: true, doneStateId: "st-done" } },
      linear,
    );
    const started = await h.orch.startFromLinear("issue-1");
    await h.orch.waitIdle();
    const sha = h.orch.getSession(started.id)!.pr!.head.sha;
    statuses.push({
      state: "closed",
      merged: true,
      headSha: sha,
      ci: { status: "success" },
    });
    await poll();

    const failed = h.orch.getSession(started.id)!;
    expect(failed.linear.syncedAt).toBeNull();
    expect(failed.linear.syncError).toBe("linear_rate_limited");
    expect(failed.warnings).toContainEqual(
      expect.objectContaining({ code: "linear_sync_failed" }),
    );

    const retried = await h.orch.syncLinear(started.id);
    expect(retried.linear.syncedAt).toEqual(expect.any(String));
    expect(retried.linear.syncError).toBeNull();
  });

  it("validates the team mapping settings", () => {
    const h = setup();
    expect(() =>
      h.orch.updateSettings({
        linear: { teams: { "bad key": { repoDir: "x" } } },
      }),
    ).toThrow(expect.objectContaining({ code: "invalid_settings" }));
    expect(() =>
      h.orch.updateSettings({ linear: { teams: { ENG: { doneStateId: 5 } } } }),
    ).toThrow(expect.objectContaining({ code: "invalid_settings" }));
    const repoDir = path.join("work", "app");
    expect(
      h.orch.updateSettings({
        linear: {
          teams: { ENG: { repoDir, baseBranch: "main", doneStateId: null } },
        },
      }).linear.teams.ENG,
    ).toEqual({ repoDir, baseBranch: "main", doneStateId: null });
  });
});

describe("orchestrator: changes, inbox and connections", () => {
  it("shows the committed diff of the session branch against its base", async () => {
    const h = setup({ settings: NO_GATES });
    const session = await toWatchingCi(h);

    const diff = await h.orch.sessionDiff(session.id);

    expect(diff.base).toBe(session.baseBranch);
    expect(diff.branch).toBe(session.branch);
    expect(diff.files).toContainEqual(
      expect.objectContaining({
        path: "hello.txt",
        additions: 1,
        deletions: 0,
      }),
    );
    expect(diff.patch).toContain("+round 1");
    expect(diff.truncated).toBe(false);
    await h.orch.stop();
  });

  it("returns an empty diff while the branch does not exist yet", async () => {
    const planner = blockingPlanner();
    const h = setup({ agent: { planner: planner.handler } });
    const started = await h.orch.startSession(
      chatRequest(h.repo.dir, "Add a hello file"),
    );
    await vi.waitFor(() => expect(h.agent.callsFor("planner")).toHaveLength(1));
    // Make the branch unreadable: point the session at a branch that is gone.
    const diff = await h.orch.sessionDiff(started.id);
    expect(diff.files).toEqual([]);
    planner.release();
    await h.orch.waitIdle();
    await expect(h.orch.sessionDiff("missing")).rejects.toMatchObject({
      code: "session_not_found",
    });
  });

  it("lists Linear issues with their mapping and active session", async () => {
    const linear = {
      listAssignedIssues: vi.fn(async () => [
        {
          id: "issue-1",
          identifier: "ENG-1",
          title: "One",
          description: "x".repeat(2000),
          url: "https://linear.app/a/issue/ENG-1",
          priority: 1,
          updatedAt: "2026-11-20T00:00:00.000Z",
          state: { id: "s", name: "Todo", type: "unstarted" },
          team: { id: "t", key: "ENG", name: "Eng" },
        },
        {
          id: "issue-2",
          identifier: "OPS-2",
          title: "Two",
          description: "",
          url: "https://linear.app/a/issue/OPS-2",
          priority: 0,
          updatedAt: "2026-11-20T00:00:00.000Z",
          state: { id: "s", name: "Todo", type: "unstarted" },
          team: { id: "t2", key: "OPS", name: "Ops" },
        },
      ]),
      getIssue: vi.fn(),
      teamStates: vi.fn(),
      moveIssue: vi.fn(),
    };
    const h = setup({ linear });
    h.orch.updateSettings({
      linear: { teams: { ENG: { repoDir: h.repo.dir } } },
    });

    const inbox = await h.orch.linearInbox();

    expect(
      inbox.issues.map((issue: { identifier: string; mapped: boolean }) => [
        issue.identifier,
        issue.mapped,
      ]),
    ).toEqual([
      ["ENG-1", true],
      ["OPS-2", false],
    ]);
    expect(inbox.issues[0].description).toHaveLength(500);
    expect(inbox.issues[0].session).toBeNull();
  });

  it("checks each connection without returning secrets", async () => {
    const h = setup({
      github: {
        viewer: vi.fn(async () => ({ login: "octocat" })),
      },
      linear: {
        viewer: vi.fn(async () => {
          throw Object.assign(new Error("Linear rejected the API key"), {
            code: "linear_key_invalid",
          });
        }),
      },
    });

    expect(await h.orch.connections()).toEqual({
      github: { ok: true, account: "octocat" },
      linear: { ok: false, error: "linear_key_invalid" },
    });
  });

  it("reports Linear as not configured when there is no client", async () => {
    const h = setup();
    expect((await h.orch.connections()).linear).toEqual({
      ok: false,
      error: "linear_not_configured",
    });
    await expect(h.orch.linearInbox()).rejects.toMatchObject({
      code: "linear_not_configured",
    });
  });
});

describe("orchestrator: clean-up after a merge", () => {
  async function mergeSession(
    extra: (h: ReturnType<typeof setup>) => {
      release?: (ids: string[]) => Promise<void>;
      removeWorktree?: (repoDir: string, dir: string) => Promise<void>;
    } = () => ({}),
  ) {
    const clock = fakeClock();
    const statuses: unknown[] = [];
    const getPullStatus = vi.fn(async () => statuses.shift());
    let hooks: ReturnType<typeof extra> = {};
    const h = setup({
      settings: NO_GATES,
      clock,
      github: { getPullStatus },
      gitOverrides: {
        removeWorktree: (repoDir: string, dir: string) =>
          hooks.removeWorktree
            ? hooks.removeWorktree(repoDir, dir)
            : createGit().removeWorktree(repoDir, dir),
      },
    });
    hooks = extra(h);
    let next = 0;
    const run = h.agent.run.getMockImplementation()!;
    h.agent.run.mockImplementation(async (call: AgentCall) => ({
      ...(await run(call)),
      conversationId: `conv-${(next += 1)}`,
    }));
    if (hooks.release) Object.assign(h.agent, { release: hooks.release });
    const session = await toWatchingCi(h);
    statuses.push({
      state: "closed",
      merged: true,
      headSha: session.pr!.head.sha,
      ci: { status: "success" },
    });
    clock.fireAll();
    await h.orch.waitIdle();
    return { h, session: h.orch.getSession(session.id)! };
  }

  it("closes the session's agent conversations, then removes the worktree", async () => {
    const seen: boolean[] = [];
    const release = vi.fn(async (_ids: string[]) => {});
    const { session } = await mergeSession((h) => ({
      release: async (ids) => {
        // The worktree is still there while the conversations close.
        const [only] = h.orch.listSessions();
        seen.push(existsSync(only.worktreeDir));
        await release(ids);
      },
    }));

    expect(session.state).toBe("COMPLETED");
    expect(release).toHaveBeenCalledWith(["conv-1", "conv-2", "conv-3"]);
    expect(seen).toEqual([true]);
    expect(session.worktreeCreated).toBe(false);
    expect(existsSync(session.worktreeDir)).toBe(false);
  });

  it("still removes the worktree when closing the conversations fails", async () => {
    const { session } = await mergeSession(() => ({
      release: async () => {
        throw new Error("agent server down");
      },
    }));

    expect(session.worktreeCreated).toBe(false);
    expect(existsSync(session.worktreeDir)).toBe(false);
  });

  it("warns instead of failing silently when the worktree cannot be removed", async () => {
    const { session } = await mergeSession(() => ({
      removeWorktree: async () => {
        throw Object.assign(new Error("EBUSY: resource busy or locked"), {
          code: "EBUSY",
        });
      },
    }));

    expect(session.state).toBe("COMPLETED");
    expect(session.worktreeCreated).toBe(true);
    expect(session.warnings).toContainEqual(
      expect.objectContaining({
        code: "worktree_cleanup_failed",
        files: [session.worktreeDir],
      }),
    );
  });
});
