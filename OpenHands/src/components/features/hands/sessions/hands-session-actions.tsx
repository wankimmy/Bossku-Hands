import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSession } from "#/api/hands/hands-types";
import {
  useCancelHandsSession,
  useRefreshHandsSession,
  useResumeHandsSession,
  useRetryHandsSession,
} from "#/hooks/mutation/use-hands-mutations";
import { isTerminalHandsState } from "#/hooks/query/use-hands";
import { BrandButton } from "#/components/features/settings/brand-button";
import { ConfirmationModal } from "#/components/shared/modals/confirmation-modal";
import { handsErrorMessage } from "../hands-labels";

/** Cancel / Resume / Retry / Refresh, shown only in the states they apply to. */
export function HandsSessionActions({ session }: { session: HandsSession }) {
  const { t } = useTranslation("openhands");
  const [confirmingCancel, setConfirmingCancel] = React.useState(false);
  const cancel = useCancelHandsSession();
  const resume = useResumeHandsSession();
  const retry = useRetryHandsSession();
  const refresh = useRefreshHandsSession();

  const { id, state } = session;
  const actionError = [cancel, resume, retry, refresh].find(
    (m) => m.isError,
  )?.error;
  const busy =
    cancel.isPending ||
    resume.isPending ||
    retry.isPending ||
    refresh.isPending;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {state === "SUSPENDED" && (
          <BrandButton
            testId="hands-resume"
            type="button"
            variant="primary"
            isDisabled={busy}
            onClick={() => resume.mutate({ id })}
          >
            {t(I18nKey.HANDS$RESUME)}
          </BrandButton>
        )}
        {state === "FAILED" && (
          <BrandButton
            testId="hands-retry"
            type="button"
            variant="primary"
            isDisabled={busy}
            onClick={() => retry.mutate({ id })}
          >
            {t(I18nKey.HANDS$RETRY_SESSION)}
          </BrandButton>
        )}
        {(state === "WATCHING_CI" || state === "READY_FOR_HUMAN_REVIEW") && (
          <BrandButton
            testId="hands-refresh"
            type="button"
            variant="secondary"
            isDisabled={busy}
            onClick={() => refresh.mutate({ id })}
          >
            {t(I18nKey.HANDS$REFRESH_NOW)}
          </BrandButton>
        )}
        {!isTerminalHandsState(state) && (
          <BrandButton
            testId="hands-cancel"
            type="button"
            variant="secondary"
            isDisabled={busy}
            onClick={() => setConfirmingCancel(true)}
          >
            {t(I18nKey.HANDS$CANCEL_SESSION)}
          </BrandButton>
        )}
      </div>
      {actionError !== undefined && (
        <p
          role="alert"
          data-testid="hands-action-error"
          className="text-sm text-danger"
        >
          {handsErrorMessage(t, actionError)}
        </p>
      )}
      {confirmingCancel && (
        <ConfirmationModal
          text={t(I18nKey.HANDS$CANCEL_CONFIRM)}
          confirmText={t(I18nKey.HANDS$CANCEL_SESSION)}
          isConfirming={cancel.isPending}
          onCancel={() => setConfirmingCancel(false)}
          onConfirm={() =>
            cancel.mutate(
              { id },
              { onSettled: () => setConfirmingCancel(false) },
            )
          }
        />
      )}
    </div>
  );
}
