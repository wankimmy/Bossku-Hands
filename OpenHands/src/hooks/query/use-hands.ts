import { useQuery } from "@tanstack/react-query";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSessionState } from "#/api/hands/hands-types";

export const HANDS_QUERY_KEYS = {
  sessions: ["hands", "sessions"] as const,
  session: (id: string) => ["hands", "session", id] as const,
  sessionDiff: (id: string) => ["hands", "session", id, "diff"] as const,
  settings: ["hands", "settings"] as const,
  connections: ["hands", "connections"] as const,
  browser: ["hands", "browser"] as const,
  linearIssues: ["hands", "linear", "issues"] as const,
  linearStates: (teamId: string) =>
    ["hands", "linear", "states", teamId] as const,
};

export const HANDS_SESSIONS_POLL_MS = 5_000;
export const HANDS_SESSION_POLL_MS = 3_000;

const TERMINAL_STATES: readonly HandsSessionState[] = [
  "COMPLETED",
  "ESCALATED",
  "CANCELLED",
  "FAILED",
  "SUPERSEDED",
];

export const isTerminalHandsState = (state: HandsSessionState) =>
  TERMINAL_STATES.includes(state);

export function useHandsSessions() {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.sessions,
    queryFn: handsService.listSessions,
    refetchInterval: HANDS_SESSIONS_POLL_MS,
    meta: { disableToast: true },
  });
}

export function useHandsSession(id: string | undefined) {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.session(id ?? ""),
    queryFn: () => handsService.getSession({ id: id ?? "" }),
    enabled: !!id,
    refetchInterval: (query) =>
      query.state.data && isTerminalHandsState(query.state.data.state)
        ? false
        : HANDS_SESSION_POLL_MS,
    meta: { disableToast: true },
  });
}

export function useHandsSessionDiff(id: string | undefined, live = false) {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.sessionDiff(id ?? ""),
    queryFn: () => handsService.getSessionDiff({ id: id ?? "" }),
    enabled: !!id,
    // While the session still runs, the branch can gain commits.
    refetchInterval: live ? HANDS_SESSION_POLL_MS : false,
    meta: { disableToast: true },
  });
}

export function useHandsSettings() {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.settings,
    queryFn: handsService.getSettings,
    meta: { disableToast: true },
  });
}

export function useHandsConnections() {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.connections,
    queryFn: handsService.getConnections,
    meta: { disableToast: true },
  });
}

export function useHandsBrowser() {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.browser,
    queryFn: handsService.getBrowser,
    meta: { disableToast: true },
  });
}

export function useLinearIssues() {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.linearIssues,
    queryFn: handsService.listLinearIssues,
    meta: { disableToast: true },
  });
}

/** Workflow states of one Linear team; idle until the team id is known. */
export function useLinearTeamStates(teamId: string | null) {
  return useQuery({
    queryKey: HANDS_QUERY_KEYS.linearStates(teamId ?? ""),
    queryFn: () => handsService.getLinearTeamStates({ teamId: teamId ?? "" }),
    enabled: !!teamId,
    meta: { disableToast: true },
  });
}
