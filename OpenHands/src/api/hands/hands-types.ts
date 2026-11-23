/**
 * Wire types for the local Bossku Hands service (`/api/hands/*`), served by
 * `scripts/hands/server.mjs` beside the agent-server while the app is open.
 */

export type HandsSessionState =
  | "PLANNING"
  | "CODING"
  | "REVIEWING"
  | "OPENING_PR"
  | "REPAIRING_CI"
  | "PUSHING_FIX"
  | "AWAITING_APPROVAL"
  | "WATCHING_CI"
  | "READY_FOR_HUMAN_REVIEW"
  | "SUSPENDED"
  | "COMPLETED"
  | "ESCALATED"
  | "CANCELLED"
  | "FAILED"
  | "SUPERSEDED";

export type HandsApprovalGate = "approve_plan" | "open_pr" | "push_fix";

export type HandsAutoFixMode = "off" | "suggest" | "local" | "update_pr";

export type HandsRole = "planner" | "coder" | "reviewer";

/** Linear settings for one team, keyed by team key (for example `ENG`). */
export interface HandsLinearTeamSettings {
  repoDir: string | null;
  baseBranch: string | null;
  doneStateId: string | null;
}

export interface HandsSettings {
  gates: { approve_plan: boolean; open_pr: boolean };
  autoFixCi: HandsAutoFixMode;
  ciRepairBudget: number;
  maxReviewRounds: number;
  ciPollIntervalMs: number;
  /** Agent profile id per role; null means not chosen yet. */
  roles: Record<HandsRole, string | null>;
  linear: { teams: Record<string, HandsLinearTeamSettings> };
}

export interface HandsSessionEvent {
  at: string;
  type: string;
  message?: string;
}

export interface HandsCiFailure {
  name: string;
  conclusion: string;
  summary: string;
}

/** A non-fatal note on a session, such as files Hands left out of a commit. */
export interface HandsWarning {
  code: string;
  files: string[];
  /** The agent role, for warnings about one stage. */
  role?: string;
  /** Agent actions the command guard blocked, with the reason given. */
  actions?: Array<{ action: string; reason: string }>;
  /** A short detail from the server, such as the error text of a failed step. */
  message?: string;
  at: string;
}

/** The Linear issue a session was started from, when there is one. */
export interface HandsSessionLinear {
  issueId: string;
  identifier: string;
  title: string;
  url: string;
  teamId: string;
  teamKey: string;
  syncedAt: string | null;
  syncError: string | null;
  doneState: string | null;
}

export interface HandsSession {
  id: string;
  state: HandsSessionState;
  request: { source: string; task: string; repoDir: string };
  repoDir: string;
  baseBranch: string;
  branch: string;
  worktreeDir: string;
  settings: HandsSettings;
  plan: string | null;
  review: { verdict: "APPROVE" | "REQUEST_CHANGES"; notes: string } | null;
  pendingApproval: HandsApprovalGate | null;
  pr: {
    number: number;
    url: string;
    head: { ref: string; sha: string };
  } | null;
  counters: { reviewRounds: number; ciRepairRounds: number };
  lastCiFailures?: HandsCiFailure[];
  escalation: { reason: string; detail: string | null } | null;
  failure: { stage: HandsSessionState; message: string } | null;
  warnings: HandsWarning[];
  events: HandsSessionEvent[];
  suspendedFrom: HandsSessionState | null;
  linear: HandsSessionLinear | null;
  conversations: Array<{ role: string; id: string }>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export interface HandsStartSessionRequest {
  task: string;
  repoDir: string;
  baseBranch?: string;
}

export interface HandsErrorBody {
  error: {
    code: string;
    message?: string;
    expected?: string;
    field?: string;
    teamKey?: string;
    sessionId?: string;
  };
}

/** A GitHub or Linear connection check. `error` is a code, never a token. */
export interface HandsConnectionStatus {
  ok: boolean;
  account?: string;
  error?: string;
}

export interface HandsConnections {
  github: HandsConnectionStatus;
  linear: HandsConnectionStatus;
}

export interface HandsBrowserStatus {
  installed: boolean;
}

export interface HandsLinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  priority: number;
  updatedAt: string;
  state: { id: string; name: string; type: string } | null;
  team: { id: string; key: string; name: string } | null;
  mapped: boolean;
  session: { id: string; state: HandsSessionState } | null;
}

export interface HandsLinearState {
  id: string;
  name: string;
  type: string;
}

export interface HandsSessionDiffFile {
  path: string;
  /** Null for a binary file. */
  additions: number | null;
  /** Null for a binary file. */
  deletions: number | null;
}

export interface HandsSessionDiff {
  base: string;
  branch: string;
  files: HandsSessionDiffFile[];
  patch: string;
  truncated: boolean;
}
