import type { TFunction } from "i18next";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import type {
  HandsApprovalGate,
  HandsAutoFixMode,
  HandsSessionState,
} from "#/api/hands/hands-types";

export const HANDS_STATE_LABEL_KEYS: Record<HandsSessionState, I18nKey> = {
  PLANNING: I18nKey.HANDS$STATE_PLANNING,
  CODING: I18nKey.HANDS$STATE_CODING,
  REVIEWING: I18nKey.HANDS$STATE_REVIEWING,
  OPENING_PR: I18nKey.HANDS$STATE_OPENING_PR,
  REPAIRING_CI: I18nKey.HANDS$STATE_REPAIRING_CI,
  PUSHING_FIX: I18nKey.HANDS$STATE_PUSHING_FIX,
  AWAITING_APPROVAL: I18nKey.HANDS$STATE_AWAITING_APPROVAL,
  WATCHING_CI: I18nKey.HANDS$STATE_WATCHING_CI,
  READY_FOR_HUMAN_REVIEW: I18nKey.HANDS$STATE_READY_FOR_HUMAN_REVIEW,
  SUSPENDED: I18nKey.HANDS$STATE_SUSPENDED,
  COMPLETED: I18nKey.HANDS$STATE_COMPLETED,
  ESCALATED: I18nKey.HANDS$STATE_ESCALATED,
  CANCELLED: I18nKey.HANDS$STATE_CANCELLED,
  FAILED: I18nKey.HANDS$STATE_FAILED,
  SUPERSEDED: I18nKey.HANDS$STATE_SUPERSEDED,
};

export const HANDS_APPROVAL_TITLE_KEYS: Record<HandsApprovalGate, I18nKey> = {
  approve_plan: I18nKey.HANDS$APPROVAL_TITLE_PLAN,
  open_pr: I18nKey.HANDS$APPROVAL_TITLE_OPEN_PR,
  push_fix: I18nKey.HANDS$APPROVAL_TITLE_PUSH_FIX,
};

export const HANDS_APPROVE_BUTTON_KEYS: Record<HandsApprovalGate, I18nKey> = {
  approve_plan: I18nKey.HANDS$APPROVE_PLAN,
  open_pr: I18nKey.HANDS$APPROVE_OPEN_PR,
  push_fix: I18nKey.HANDS$APPROVE_PUSH_FIX,
};

const ESCALATION_KEYS: Record<string, I18nKey> = {
  ci_infrastructure_failure: I18nKey.HANDS$ESCALATION_CI_INFRASTRUCTURE_FAILURE,
  same_failure_repeated_without_progress:
    I18nKey.HANDS$ESCALATION_SAME_FAILURE_REPEATED_WITHOUT_PROGRESS,
  ci_repair_budget_exhausted:
    I18nKey.HANDS$ESCALATION_CI_REPAIR_BUDGET_EXHAUSTED,
  ci_fix_failed: I18nKey.HANDS$ESCALATION_CI_FIX_FAILED,
  auto_fix_off: I18nKey.HANDS$ESCALATION_AUTO_FIX_OFF,
  fix_suggested: I18nKey.HANDS$ESCALATION_FIX_SUGGESTED,
  review_rounds_exhausted: I18nKey.HANDS$ESCALATION_REVIEW_ROUNDS_EXHAUSTED,
  coder_made_no_changes: I18nKey.HANDS$ESCALATION_CODER_MADE_NO_CHANGES,
  branch_changed_unexpectedly:
    I18nKey.HANDS$ESCALATION_BRANCH_CHANGED_UNEXPECTEDLY,
};

/** A readable sentence for an escalation reason code. */
export function escalationSentence(t: TFunction, reason: string): string {
  const key = ESCALATION_KEYS[reason];
  return key ? t(key) : t(I18nKey.HANDS$ESCALATION_UNKNOWN, { reason });
}

export const HANDS_AUTO_FIX_OPTIONS: ReadonlyArray<{
  mode: HandsAutoFixMode;
  label: I18nKey;
  description: I18nKey;
}> = [
  {
    mode: "off",
    label: I18nKey.HANDS$AUTO_FIX_OFF,
    description: I18nKey.HANDS$AUTO_FIX_OFF_DESC,
  },
  {
    mode: "suggest",
    label: I18nKey.HANDS$AUTO_FIX_SUGGEST,
    description: I18nKey.HANDS$AUTO_FIX_SUGGEST_DESC,
  },
  {
    mode: "local",
    label: I18nKey.HANDS$AUTO_FIX_LOCAL,
    description: I18nKey.HANDS$AUTO_FIX_LOCAL_DESC,
  },
  {
    mode: "update_pr",
    label: I18nKey.HANDS$AUTO_FIX_UPDATE_PR,
    description: I18nKey.HANDS$AUTO_FIX_UPDATE_PR_DESC,
  },
];

const ERROR_KEYS: Record<string, I18nKey> = {
  invalid_task: I18nKey.HANDS$ERROR_INVALID_TASK,
  not_a_git_repository: I18nKey.HANDS$ERROR_NOT_A_GIT_REPOSITORY,
  invalid_base_branch: I18nKey.HANDS$ERROR_INVALID_BASE_BRANCH,
  session_not_found: I18nKey.HANDS$ERROR_SESSION_NOT_FOUND,
  approval_gate_mismatch: I18nKey.HANDS$ERROR_APPROVAL_GATE_MISMATCH,
  not_awaiting_approval: I18nKey.HANDS$ERROR_NOT_AWAITING_APPROVAL,
  session_finished: I18nKey.HANDS$ERROR_SESSION_FINISHED,
  not_suspended: I18nKey.HANDS$ERROR_NOT_SUSPENDED,
  not_failed: I18nKey.HANDS$ERROR_NOT_FAILED,
  orchestrator_stopped: I18nKey.HANDS$ERROR_ORCHESTRATOR_STOPPED,
  invalid_settings: I18nKey.HANDS$ERROR_INVALID_SETTINGS,
  linear_key_missing: I18nKey.HANDS$ERROR_LINEAR_KEY_MISSING,
  linear_not_configured: I18nKey.HANDS$ERROR_LINEAR_KEY_MISSING,
  linear_key_invalid: I18nKey.HANDS$ERROR_LINEAR_KEY_INVALID,
  linear_rate_limited: I18nKey.HANDS$ERROR_LINEAR_RATE_LIMITED,
  linear_request_failed: I18nKey.HANDS$ERROR_LINEAR_REQUEST_FAILED,
  linear_team_not_mapped: I18nKey.HANDS$LINEAR_TEAM_NOT_MAPPED,
  linear_issue_in_progress: I18nKey.HANDS$ERROR_LINEAR_ISSUE_IN_PROGRESS,
  linear_sync_not_ready: I18nKey.HANDS$ERROR_LINEAR_SYNC_NOT_READY,
  github_token_missing: I18nKey.HANDS$ERROR_GITHUB_TOKEN_MISSING,
  github_token_invalid: I18nKey.HANDS$ERROR_GITHUB_TOKEN_INVALID,
  github_rate_limited: I18nKey.HANDS$ERROR_GITHUB_RATE_LIMITED,
  github_request_failed: I18nKey.HANDS$ERROR_GITHUB_REQUEST_FAILED,
  agent_server_request_failed: I18nKey.HANDS$ERROR_AGENT_SERVER_REQUEST_FAILED,
  not_supported: I18nKey.HANDS$ERROR_NOT_SUPPORTED,
};

/** The readable sentence for a server error or status code. */
export function handsCodeMessage(t: TFunction, code: string | null): string {
  const key = code ? ERROR_KEYS[code] : undefined;
  return t(key ?? I18nKey.HANDS$ERROR_UNKNOWN, { team: "" });
}

/** Maps the server's `error.code` to a readable message. */
export function handsErrorMessage(t: TFunction, error: unknown): string {
  if (!(error instanceof HandsApiError)) {
    return t(I18nKey.HANDS$ERROR_UNKNOWN);
  }
  const key = error.code ? ERROR_KEYS[error.code] : undefined;
  return t(key ?? I18nKey.HANDS$ERROR_UNKNOWN, { team: error.teamKey ?? "" });
}

/** Sessions that wait for a person to approve or review them. */
export function needsHumanReview(state: HandsSessionState): boolean {
  return state === "AWAITING_APPROVAL" || state === "READY_FOR_HUMAN_REVIEW";
}

/** Linear priority numbers, where 0 means none and 1 is the most urgent. */
const PRIORITY_KEYS: Record<number, I18nKey> = {
  1: I18nKey.HANDS$LINEAR_PRIORITY_URGENT,
  2: I18nKey.HANDS$LINEAR_PRIORITY_HIGH,
  3: I18nKey.HANDS$LINEAR_PRIORITY_MEDIUM,
  4: I18nKey.HANDS$LINEAR_PRIORITY_LOW,
};

export function linearPriorityLabel(t: TFunction, priority: number): string {
  return t(PRIORITY_KEYS[priority] ?? I18nKey.HANDS$LINEAR_PRIORITY_NONE);
}

/** Last path segment of a local folder path (either slash style). */
export function repoFolderName(repoDir: string): string {
  const segments = repoDir.split(/[\\/]+/).filter(Boolean);
  return segments.at(-1) ?? repoDir;
}

/** First non-empty line of the task, used as the session title. */
export function taskTitle(task: string): string {
  return (
    task
      .split("\n")
      .find((line) => line.trim())
      ?.trim() ?? task
  );
}
