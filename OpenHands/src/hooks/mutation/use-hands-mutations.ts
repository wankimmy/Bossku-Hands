import { useMutation, useQueryClient } from "@tanstack/react-query";
import { handsService } from "#/api/hands/hands-service.api";
import type {
  HandsApprovalGate,
  HandsSession,
  HandsSettings,
  HandsStartSessionRequest,
} from "#/api/hands/hands-types";
import { HANDS_QUERY_KEYS } from "#/hooks/query/use-hands";

// Callers show the server's error code inline, so skip the global toast.
const META = { disableToast: true };

function useStoreSession() {
  const queryClient = useQueryClient();
  return (session: HandsSession) => {
    queryClient.setQueryData(HANDS_QUERY_KEYS.session(session.id), session);
    queryClient.invalidateQueries({ queryKey: HANDS_QUERY_KEYS.sessions });
  };
}

export function useStartHandsSession() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (body: HandsStartSessionRequest) =>
      handsService.startSession(body),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useApproveHandsSession() {
  const storeSession = useStoreSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: { id: string; gate: HandsApprovalGate }) =>
      handsService.approve(variables),
    meta: META,
    onSuccess: storeSession,
    // A gate mismatch means the page was stale; reload the session.
    onError: (_error, { id }) =>
      queryClient.invalidateQueries({ queryKey: HANDS_QUERY_KEYS.session(id) }),
  });
}

export function useCancelHandsSession() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (variables: { id: string }) => handsService.cancel(variables),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useResumeHandsSession() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (variables: { id: string }) => handsService.resume(variables),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useRetryHandsSession() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (variables: { id: string }) => handsService.retry(variables),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useRefreshHandsSession() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (variables: { id: string }) => handsService.refresh(variables),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useUpdateHandsSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: Partial<HandsSettings>) =>
      handsService.updateSettings(patch),
    meta: META,
    onSuccess: (settings) => {
      queryClient.setQueryData(HANDS_QUERY_KEYS.settings, settings);
      // Team mappings decide whether an inbox issue can start.
      queryClient.invalidateQueries({
        queryKey: HANDS_QUERY_KEYS.linearIssues,
      });
    },
  });
}

export function useStartLinearIssue() {
  const storeSession = useStoreSession();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variables: {
      issueId: string;
      repoDir?: string;
      baseBranch?: string;
    }) => handsService.startLinearIssue(variables),
    meta: META,
    onSuccess: (session) => {
      storeSession(session);
      queryClient.invalidateQueries({
        queryKey: HANDS_QUERY_KEYS.linearIssues,
      });
    },
  });
}

export function useLinearSync() {
  const storeSession = useStoreSession();
  return useMutation({
    mutationFn: (variables: { id: string }) =>
      handsService.linearSync(variables),
    meta: META,
    onSuccess: storeSession,
  });
}

export function useAddEdgeBrowser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => handsService.addEdgeBrowser(),
    meta: META,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: HANDS_QUERY_KEYS.browser }),
  });
}
