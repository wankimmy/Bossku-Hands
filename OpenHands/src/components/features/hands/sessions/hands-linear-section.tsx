import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSession } from "#/api/hands/hands-types";
import { useLinearSync } from "#/hooks/mutation/use-hands-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import { handsErrorMessage } from "../hands-labels";

const noticeClassName =
  "flex flex-col gap-2 rounded-xl border border-border p-4 text-sm";

/** The Linear issue behind the session, and whether its Done update landed. */
export function HandsLinearSection({ session }: { session: HandsSession }) {
  const { t } = useTranslation("openhands");
  const sync = useLinearSync();
  const linear = session.linear;
  if (!linear) return null;

  let status: string;
  if (linear.syncError) {
    status = t(I18nKey.HANDS$LINEAR_SYNC_FAILED);
  } else if (linear.syncedAt) {
    status = t(I18nKey.HANDS$LINEAR_SYNC_DONE, {
      state: linear.doneState ?? t(I18nKey.HANDS$LINEAR_DONE_FALLBACK),
    });
  } else if (session.state === "COMPLETED") {
    status = t(I18nKey.HANDS$LINEAR_SYNC_PENDING);
  } else {
    status = t(I18nKey.HANDS$LINEAR_SYNC_WAITING);
  }
  const canRetry =
    session.state === "COMPLETED" && (!!linear.syncError || !linear.syncedAt);

  return (
    <section
      data-testid="hands-linear-section"
      aria-labelledby="hands-linear-title"
      className={noticeClassName}
    >
      <h2 id="hands-linear-title" className="font-semibold">
        {t(I18nKey.HANDS$LINEAR_SECTION)}
      </h2>
      <p className="break-words">
        <a
          href={linear.url}
          target="_blank"
          rel="noreferrer"
          className="text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {linear.identifier}
        </a>{" "}
        <span>{linear.title}</span>
      </p>
      <p data-testid="hands-linear-sync-status">{status}</p>
      {sync.isError && (
        <p role="alert" className="text-danger">
          {handsErrorMessage(t, sync.error)}
        </p>
      )}
      {canRetry && (
        <div>
          <BrandButton
            testId="hands-linear-retry"
            type="button"
            variant="secondary"
            isDisabled={sync.isPending}
            onClick={() => sync.mutate({ id: session.id })}
          >
            {t(I18nKey.HANDS$LINEAR_RETRY_SYNC)}
          </BrandButton>
        </div>
      )}
    </section>
  );
}
