import axios, { type AxiosRequestConfig } from "axios";
import { getEffectiveLocalBackend } from "../backend-registry/active-store";
import { NoBackendAvailableError } from "../agent-server-client-options";
import { handsErrorFromBody } from "./hands-error";
import type {
  HandsApprovalGate,
  HandsBrowserStatus,
  HandsConnections,
  HandsLinearIssue,
  HandsLinearState,
  HandsSession,
  HandsSessionDiff,
  HandsSettings,
  HandsStartSessionRequest,
} from "./hands-types";

const HANDS_BASE_PATH = "/api/hands";

// The Hands service is a local sidecar behind the same origin as the local
// agent-server (the dev ingress routes `/api/hands` to it), so it uses the
// local backend's host and the same `X-Session-API-Key` header as automations.
const handsAxios = axios.create();

handsAxios.interceptors.request.use((config) => {
  const backend = getEffectiveLocalBackend();
  if (!backend) throw new NoBackendAvailableError();
  // eslint-disable-next-line no-param-reassign
  config.baseURL = backend.host;
  const apiKey = backend.apiKey?.trim();
  if (apiKey) config.headers.set("X-Session-API-Key", apiKey);
  return config;
});

async function request<T>(config: AxiosRequestConfig): Promise<T> {
  try {
    const response = await handsAxios.request<T>(config);
    return response.data;
  } catch (error) {
    if (axios.isAxiosError(error) && error.response) {
      throw handsErrorFromBody(
        error.response.status,
        error.response.data,
        error.message,
      );
    }
    throw error;
  }
}

const sessionPath = (id: string, action?: string) =>
  `${HANDS_BASE_PATH}/sessions/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

export const handsService = {
  getHealth: () =>
    request<{ ok: boolean }>({ url: `${HANDS_BASE_PATH}/health` }),

  listSessions: async (): Promise<HandsSession[]> =>
    (
      await request<{ sessions: HandsSession[] }>({
        url: `${HANDS_BASE_PATH}/sessions`,
      })
    ).sessions,

  startSession: (body: HandsStartSessionRequest) =>
    request<HandsSession>({
      method: "POST",
      url: `${HANDS_BASE_PATH}/sessions`,
      data: body,
    }),

  getSession: ({ id }: { id: string }) =>
    request<HandsSession>({ url: sessionPath(id) }),

  approve: ({ id, gate }: { id: string; gate: HandsApprovalGate }) =>
    request<HandsSession>({
      method: "POST",
      url: sessionPath(id, "approve"),
      data: { gate },
    }),

  cancel: ({ id }: { id: string }) =>
    request<HandsSession>({ method: "POST", url: sessionPath(id, "cancel") }),

  resume: ({ id }: { id: string }) =>
    request<HandsSession>({ method: "POST", url: sessionPath(id, "resume") }),

  retry: ({ id }: { id: string }) =>
    request<HandsSession>({ method: "POST", url: sessionPath(id, "retry") }),

  refresh: ({ id }: { id: string }) =>
    request<HandsSession>({ method: "POST", url: sessionPath(id, "refresh") }),

  getSettings: () =>
    request<HandsSettings>({ url: `${HANDS_BASE_PATH}/settings` }),

  updateSettings: (patch: Partial<HandsSettings>) =>
    request<HandsSettings>({
      method: "PUT",
      url: `${HANDS_BASE_PATH}/settings`,
      data: patch,
    }),

  getConnections: () =>
    request<HandsConnections>({ url: `${HANDS_BASE_PATH}/connections` }),

  getBrowser: () =>
    request<HandsBrowserStatus>({ url: `${HANDS_BASE_PATH}/browser` }),

  addEdgeBrowser: () =>
    request<{ installed: true; added: boolean }>({
      method: "POST",
      url: `${HANDS_BASE_PATH}/browser/edge`,
    }),

  listLinearIssues: async (): Promise<HandsLinearIssue[]> =>
    (
      await request<{ issues: HandsLinearIssue[] }>({
        url: `${HANDS_BASE_PATH}/linear/issues`,
      })
    ).issues,

  startLinearIssue: ({
    issueId,
    ...body
  }: {
    issueId: string;
    repoDir?: string;
    baseBranch?: string;
  }) =>
    request<HandsSession>({
      method: "POST",
      url: `${HANDS_BASE_PATH}/linear/issues/${encodeURIComponent(issueId)}/start`,
      data: body,
    }),

  getLinearTeamStates: async ({
    teamId,
  }: {
    teamId: string;
  }): Promise<HandsLinearState[]> =>
    (
      await request<{ states: HandsLinearState[] }>({
        url: `${HANDS_BASE_PATH}/linear/teams/${encodeURIComponent(teamId)}/states`,
      })
    ).states,

  linearSync: ({ id }: { id: string }) =>
    request<HandsSession>({
      method: "POST",
      url: sessionPath(id, "linear-sync"),
    }),

  getSessionDiff: ({ id }: { id: string }) =>
    request<HandsSessionDiff>({ url: sessionPath(id, "diff") }),
};
