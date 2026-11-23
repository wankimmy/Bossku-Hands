import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSession } from "#/api/hands/hands-types";
import { useApproveHandsSession } from "#/hooks/mutation/use-hands-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import {
  HANDS_APPROVAL_TITLE_KEYS,
  HANDS_APPROVE_BUTTON_KEYS,
  handsErrorMessage,
} from "../hands-labels";
import { HandsCiFailures } from "./hands-ci-failures";

const preClassName =
  "max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3 text-sm text-contrast";

/** What is being approved, plus a button for exactly the pending gate. */
export function HandsApprovalPanel({ session }: { session: HandsSession }) {
  const { t } = useTranslation("openhands");
  const approve = useApproveHandsSession();
  const gate = session.pendingApproval;
  if (session.state !== "AWAITING_APPROVAL" || !gate) return null;

  return (
    <section
      data-testid="hands-approval-panel"
      aria-labelledby="hands-approval-title"
      className="flex flex-col gap-3 rounded-xl border border-border p-4"
    >
      <h2 id="hands-approval-title" className="text-base font-semibold">
        {t(HANDS_APPROVAL_TITLE_KEYS[gate])}
      </h2>
      {gate === "approve_plan" && (
        <div>
          <h3 className="mb-1 text-sm font-medium">
            {t(I18nKey.HANDS$PLAN_HEADING)}
          </h3>
          {session.plan ? (
            <pre className={preClassName}>{session.plan}</pre>
          ) : (
            <p className="text-sm text-muted">{t(I18nKey.HANDS$NO_PLAN)}</p>
          )}
        </div>
      )}
      {gate === "open_pr" && (
        <div>
          <h3 className="mb-1 text-sm font-medium">
            {t(I18nKey.HANDS$REVIEW_HEADING)}
          </h3>
          {session.review && (
            <>
              <p className="text-sm">
                {session.review.verdict === "APPROVE"
                  ? t(I18nKey.HANDS$REVIEW_APPROVE)
                  : t(I18nKey.HANDS$REVIEW_REQUEST_CHANGES)}
              </p>
              {session.review.notes && (
                <pre className={`mt-2 ${preClassName}`}>
                  {session.review.notes}
                </pre>
              )}
            </>
          )}
        </div>
      )}
      {gate === "push_fix" && (
        <div className="flex flex-col gap-2">
          <p className="text-sm">{t(I18nKey.HANDS$FIX_READY)}</p>
          <HandsCiFailures failures={session.lastCiFailures} defaultOpen />
        </div>
      )}
      {approve.isError && (
        <p
          role="alert"
          data-testid="hands-approve-error"
          className="text-sm text-danger"
        >
          {handsErrorMessage(t, approve.error)}
        </p>
      )}
      <div>
        <BrandButton
          testId="hands-approve"
          type="button"
          variant="primary"
          isDisabled={approve.isPending}
          onClick={() => approve.mutate({ id: session.id, gate })}
        >
          {t(HANDS_APPROVE_BUTTON_KEYS[gate])}
        </BrandButton>
      </div>
    </section>
  );
}
