import { http, HttpResponse } from "msw";
import type {
  HandsApprovalGate,
  HandsConnections,
  HandsLinearIssue,
  HandsLinearState,
  HandsSession,
  HandsSessionDiff,
  HandsSessionState,
  HandsSessionLinear,
  HandsSettings,
} from "#/api/hands/hands-types";

const MOCK_SETTINGS: HandsSettings = {
  gates: { approve_plan: true, open_pr: true },
  autoFixCi: "local",
  ciRepairBudget: 3,
  maxReviewRounds: 2,
  ciPollIntervalMs: 30_000,
  roles: { planner: null, coder: null, reviewer: null },
  linear: {
    teams: {
      ENG: {
        repoDir: "C:\\work\\demo-app",
        baseBranch: "main",
        doneStateId: "state-shipped",
      },
    },
  },
};

const MOCK_TEAMS = {
  ENG: { id: "team-eng", key: "ENG", name: "Engineering" },
  OPS: { id: "team-ops", key: "OPS", name: "Operations" },
} as const;

const MOCK_LINEAR_STATES: Record<string, HandsLinearState[]> = {
  "team-eng": [
    { id: "state-todo", name: "Todo", type: "unstarted" },
    { id: "state-progress", name: "In Progress", type: "started" },
    { id: "state-done", name: "Done", type: "completed" },
    { id: "state-shipped", name: "Shipped", type: "completed" },
    { id: "state-cancelled", name: "Cancelled", type: "canceled" },
  ],
  "team-ops": [
    { id: "ops-todo", name: "Todo", type: "unstarted" },
    { id: "ops-done", name: "Done", type: "completed" },
  ],
};

const minutesAgo = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function mockSession(
  id: string,
  state: HandsSessionState,
  task: string,
  overrides: Partial<HandsSession> = {},
): HandsSession {
  return {
    id,
    state,
    request: { source: "ui", task, repoDir: "C:\\work\\demo-app" },
    repoDir: "C:\\work\\demo-app",
    baseBranch: "main",
    branch: `hands/${id}`,
    worktreeDir: `C:\\work\\.hands\\${id}`,
    settings: MOCK_SETTINGS,
    plan: null,
    review: null,
    pendingApproval: null,
    pr: null,
    counters: { reviewRounds: 1, ciRepairRounds: 0 },
    escalation: null,
    failure: null,
    warnings: [],
    events: [{ at: minutesAgo(30), type: "session_started" }],
    suspendedFrom: null,
    linear: null,
    conversations: [],
    createdAt: minutesAgo(30),
    updatedAt: minutesAgo(2),
    finishedAt: null,
    ...overrides,
  };
}

const linearLink = (
  identifier: string,
  title: string,
  overrides: Partial<HandsSessionLinear> = {},
): HandsSessionLinear => ({
  issueId: `issue-${identifier}`,
  identifier,
  title,
  url: `https://linear.app/example/issue/${identifier.toLowerCase()}`,
  teamId: MOCK_TEAMS.ENG.id,
  teamKey: "ENG",
  syncedAt: null,
  syncError: null,
  doneState: "Shipped",
  ...overrides,
});

const MOCK_DIFFS: Record<string, HandsSessionDiff> = {
  "s-ready": {
    base: "main",
    branch: "hands/s-ready",
    files: [
      { path: "src/theme/date-format.ts", additions: 42, deletions: 9 },
      { path: "src/components/header.tsx", additions: 6, deletions: 1 },
      { path: "public/brand/logo.png", additions: null, deletions: null },
    ],
    patch: [
      "diff --git a/src/theme/date-format.ts b/src/theme/date-format.ts",
      "--- a/src/theme/date-format.ts",
      "+++ b/src/theme/date-format.ts",
      "@@ -1,6 +1,9 @@",
      " export function formatDate(value: Date) {",
      "-  return value.toLocaleDateString();",
      "+  return new Intl.DateTimeFormat(undefined, {",
      '+    dateStyle: "medium",',
      "+  }).format(value);",
      " }",
      "+",
      '+export const DATE_LOCALE_NOTE = "Uses the browser locale.";',
      "",
    ].join("\n"),
    truncated: false,
  },
};

const emptyDiff = (session: HandsSession): HandsSessionDiff => ({
  base: session.baseBranch,
  branch: session.branch,
  files: [],
  patch: "",
  truncated: false,
});

const MOCK_LINEAR_ISSUES: HandsLinearIssue[] = [
  {
    id: "issue-ENG-101",
    identifier: "ENG-101",
    title: "Add export button to the reports page",
    description: "Reports should download as CSV.",
    url: "https://linear.app/example/issue/eng-101",
    priority: 2,
    updatedAt: minutesAgo(35),
    state: { id: "state-todo", name: "Todo", type: "unstarted" },
    team: { ...MOCK_TEAMS.ENG },
    mapped: true,
    session: null,
  },
  {
    id: "issue-ENG-102",
    identifier: "ENG-102",
    title: "Fix login redirect loop",
    description: "After sign-in the page reloads forever on Safari.",
    url: "https://linear.app/example/issue/eng-102",
    priority: 1,
    updatedAt: minutesAgo(12),
    state: { id: "state-progress", name: "In Progress", type: "started" },
    team: { ...MOCK_TEAMS.ENG },
    mapped: true,
    session: { id: "s-linear-active", state: "CODING" },
  },
  {
    id: "issue-OPS-7",
    identifier: "OPS-7",
    title: "Rotate the backup encryption keys",
    description: "",
    url: "https://linear.app/example/issue/ops-7",
    priority: 0,
    updatedAt: minutesAgo(600),
    state: { id: "ops-todo", name: "Todo", type: "unstarted" },
    team: { ...MOCK_TEAMS.OPS },
    mapped: false,
    session: null,
  },
];

let linearIssues: HandsLinearIssue[] = [];
let browserInstalled = false;
let connections: HandsConnections = {
  github: { ok: true, account: "demo-user" },
  linear: { ok: false, error: "linear_key_missing" },
};

const pr = (number: number) => ({
  number,
  url: `https://github.com/example/demo-app/pull/${number}`,
  head: { ref: `hands/s${number}`, sha: "abc1234" },
});

const INITIAL_SESSIONS = (): HandsSession[] => [
  mockSession(
    "s-plan",
    "AWAITING_APPROVAL",
    "Add a dark mode toggle\nPersist it in local storage.",
    {
      pendingApproval: "approve_plan",
      plan: "1. Add a theme store.\n2. Add the toggle to the header.\n3. Cover it with a test.",
    },
  ),
  mockSession("s-ci", "WATCHING_CI", "Fix flaky login test", {
    pr: pr(42),
    counters: { reviewRounds: 1, ciRepairRounds: 1 },
    updatedAt: minutesAgo(10),
  }),
  mockSession("s-ready", "READY_FOR_HUMAN_REVIEW", "Upgrade date library", {
    pr: pr(40),
    updatedAt: minutesAgo(90),
  }),
  mockSession("s-esc", "ESCALATED", "Speed up the build", {
    pr: pr(38),
    escalation: { reason: "ci_repair_budget_exhausted", detail: null },
    counters: { reviewRounds: 1, ciRepairRounds: 3 },
    updatedAt: minutesAgo(300),
  }),
  mockSession("s-failed", "FAILED", "Rename the settings module", {
    failure: {
      stage: "CODING",
      message: "The coding agent exited unexpectedly.",
    },
    updatedAt: minutesAgo(1500),
  }),
  mockSession("s-done", "COMPLETED", "Fix typo in README", {
    pr: pr(35),
    updatedAt: minutesAgo(4000),
    finishedAt: minutesAgo(4000),
  }),
  mockSession("s-linear-active", "CODING", "Fix login redirect loop", {
    linear: linearLink("ENG-102", "Fix login redirect loop"),
    updatedAt: minutesAgo(5),
  }),
  mockSession("s-linear-done", "COMPLETED", "Add dark mode to settings", {
    pr: pr(36),
    linear: linearLink("ENG-88", "Add dark mode to settings", {
      syncError: "Linear returned 503 while moving the issue.",
    }),
    warnings: [
      {
        code: "linear_sync_failed",
        files: [],
        message: "Linear returned 503 while moving the issue.",
        at: minutesAgo(200),
      },
    ],
    updatedAt: minutesAgo(200),
    finishedAt: minutesAgo(200),
  }),
];

let sessions = INITIAL_SESSIONS();
let settings: HandsSettings = structuredClone(MOCK_SETTINGS);

export const resetHandsMockData = () => {
  sessions = INITIAL_SESSIONS();
  settings = structuredClone(MOCK_SETTINGS);
  linearIssues = structuredClone(MOCK_LINEAR_ISSUES);
  browserInstalled = false;
  connections = {
    github: { ok: true, account: "demo-user" },
    linear: { ok: false, error: "linear_key_missing" },
  };
};

resetHandsMockData();

/** An issue is mapped when its team has a repository folder in settings. */
const withMapping = (issue: HandsLinearIssue): HandsLinearIssue => {
  const teamKey = issue.team?.key ?? "";
  const mapped = !!settings.linear.teams[teamKey]?.repoDir;
  return { ...issue, mapped };
};

const errorResponse = (status: number, code: string, extra = {}) =>
  HttpResponse.json({ error: { code, ...extra } }, { status });

const findSession = (id: string | readonly string[] | undefined) =>
  sessions.find((session) => session.id === id);

function transition(
  id: string | readonly string[] | undefined,
  allowed: readonly HandsSessionState[],
  code: string,
  apply: (session: HandsSession) => unknown,
) {
  const session = findSession(id);
  if (!session) return errorResponse(404, "session_not_found");
  if (!allowed.includes(session.state)) return errorResponse(409, code);
  apply(session);
  session.updatedAt = new Date().toISOString();
  return HttpResponse.json(session);
}

export const HANDS_HANDLERS = [
  http.get("*/api/hands/health", () => HttpResponse.json({ ok: true })),

  http.get("*/api/hands/sessions", () => HttpResponse.json({ sessions })),

  http.post("*/api/hands/sessions", async ({ request }) => {
    const body = (await request.json()) as {
      task?: string;
      repoDir?: string;
      baseBranch?: string;
    };
    if (!body.task?.trim()) return errorResponse(400, "invalid_task");
    if (!body.repoDir?.trim())
      return errorResponse(400, "not_a_git_repository");
    const session = mockSession(
      `s-${Date.now().toString(36)}`,
      "PLANNING",
      body.task,
      {
        repoDir: body.repoDir,
        request: { source: "ui", task: body.task, repoDir: body.repoDir },
        baseBranch: body.baseBranch || "main",
      },
    );
    sessions = [session, ...sessions];
    return HttpResponse.json(session, { status: 201 });
  }),

  http.get("*/api/hands/sessions/:id", ({ params }) => {
    const session = findSession(params.id);
    return session
      ? HttpResponse.json(session)
      : errorResponse(404, "session_not_found");
  }),

  http.post("*/api/hands/sessions/:id/approve", async ({ params, request }) => {
    const { gate } = (await request.json()) as { gate: HandsApprovalGate };
    const session = findSession(params.id);
    if (!session) return errorResponse(404, "session_not_found");
    if (session.state !== "AWAITING_APPROVAL" || !session.pendingApproval) {
      return errorResponse(409, "not_awaiting_approval");
    }
    if (session.pendingApproval !== gate) {
      return errorResponse(409, "approval_gate_mismatch", {
        expected: session.pendingApproval,
      });
    }
    session.pendingApproval = null;
    session.state = gate === "approve_plan" ? "CODING" : "WATCHING_CI";
    session.updatedAt = new Date().toISOString();
    return HttpResponse.json(session);
  }),

  http.post("*/api/hands/sessions/:id/cancel", ({ params }) =>
    transition(
      params.id,
      [
        "PLANNING",
        "CODING",
        "REVIEWING",
        "OPENING_PR",
        "REPAIRING_CI",
        "PUSHING_FIX",
        "AWAITING_APPROVAL",
        "WATCHING_CI",
        "READY_FOR_HUMAN_REVIEW",
        "SUSPENDED",
      ],
      "session_finished",
      (session) =>
        Object.assign(session, { state: "CANCELLED", pendingApproval: null }),
    ),
  ),

  http.post("*/api/hands/sessions/:id/resume", ({ params }) =>
    transition(params.id, ["SUSPENDED"], "not_suspended", (session) =>
      Object.assign(session, {
        state: session.suspendedFrom ?? "PLANNING",
        suspendedFrom: null,
      }),
    ),
  ),

  http.post("*/api/hands/sessions/:id/retry", ({ params }) =>
    transition(params.id, ["FAILED"], "not_failed", (session) =>
      Object.assign(session, {
        state: session.failure?.stage ?? "PLANNING",
        failure: null,
      }),
    ),
  ),

  http.post("*/api/hands/sessions/:id/refresh", ({ params }) =>
    transition(
      params.id,
      ["WATCHING_CI", "READY_FOR_HUMAN_REVIEW"],
      "session_finished",
      () => {},
    ),
  ),

  http.get("*/api/hands/settings", () => HttpResponse.json(settings)),

  http.put("*/api/hands/settings", async ({ request }) => {
    const patch = (await request.json()) as Partial<HandsSettings>;
    const budget = patch.ciRepairBudget;
    if (
      budget !== undefined &&
      !(Number.isInteger(budget) && budget >= 0 && budget <= 10)
    ) {
      return errorResponse(400, "invalid_settings", {
        field: "ciRepairBudget",
      });
    }
    settings = {
      ...settings,
      ...patch,
      gates: { ...settings.gates, ...patch.gates },
      roles: { ...settings.roles, ...patch.roles },
      // A linear patch replaces the whole team map, as the server does.
      linear: patch.linear ?? settings.linear,
    };
    return HttpResponse.json(settings);
  }),

  http.get("*/api/hands/connections", () => HttpResponse.json(connections)),

  http.get("*/api/hands/browser", () =>
    HttpResponse.json({ installed: browserInstalled }),
  ),

  http.post("*/api/hands/browser/edge", () => {
    const added = !browserInstalled;
    browserInstalled = true;
    return HttpResponse.json({ installed: true, added });
  }),

  http.get("*/api/hands/linear/issues", () =>
    HttpResponse.json({ issues: linearIssues.map(withMapping) }),
  ),

  http.get("*/api/hands/linear/teams/:teamId/states", ({ params }) => {
    const states = MOCK_LINEAR_STATES[String(params.teamId)];
    return states
      ? HttpResponse.json({ states })
      : errorResponse(404, "linear_team_not_found");
  }),

  http.post("*/api/hands/linear/issues/:issueId/start", async ({ params }) => {
    const issue = linearIssues.find((item) => item.id === params.issueId);
    if (!issue) return errorResponse(404, "linear_issue_not_found");
    const teamKey = issue.team?.key ?? "";
    if (!settings.linear.teams[teamKey]?.repoDir) {
      return errorResponse(409, "linear_team_not_mapped", { teamKey });
    }
    if (issue.session) {
      return errorResponse(409, "linear_issue_in_progress", {
        sessionId: issue.session.id,
      });
    }
    const session = mockSession(
      `s-${Date.now().toString(36)}`,
      "PLANNING",
      `${issue.identifier} ${issue.title}`,
      {
        repoDir: settings.linear.teams[teamKey].repoDir ?? "",
        request: {
          source: "linear",
          task: `${issue.identifier} ${issue.title}`,
          repoDir: settings.linear.teams[teamKey].repoDir ?? "",
        },
        linear: linearLink(issue.identifier, issue.title, {
          issueId: issue.id,
          teamId: issue.team?.id ?? "",
          teamKey,
        }),
      },
    );
    sessions = [session, ...sessions];
    issue.session = { id: session.id, state: session.state };
    return HttpResponse.json(session, { status: 201 });
  }),

  http.post("*/api/hands/sessions/:id/linear-sync", ({ params }) => {
    const session = findSession(params.id);
    if (!session) return errorResponse(404, "session_not_found");
    if (session.state !== "COMPLETED" || !session.linear) {
      return errorResponse(409, "linear_sync_not_ready");
    }
    session.linear = {
      ...session.linear,
      syncedAt: new Date().toISOString(),
      syncError: null,
    };
    session.warnings = session.warnings.filter(
      (warning) => warning.code !== "linear_sync_failed",
    );
    session.updatedAt = new Date().toISOString();
    return HttpResponse.json(session);
  }),

  http.get("*/api/hands/sessions/:id/diff", ({ params }) => {
    const session = findSession(params.id);
    if (!session) return errorResponse(404, "session_not_found");
    return HttpResponse.json(MOCK_DIFFS[session.id] ?? emptyDiff(session));
  }),
];
