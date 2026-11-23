import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useHandsSessions } from "#/hooks/query/use-hands";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsSectionNav } from "#/components/features/hands/hands-section-nav";
import { HandsStateBadge } from "#/components/features/hands/sessions/hands-state-badge";
import { NavigationLink } from "#/components/shared/navigation-link";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { extensionModuleEmptyStateClassName } from "#/utils/extension-module-card-classes";
import {
  handsErrorMessage,
  needsHumanReview,
  repoFolderName,
  taskTitle,
} from "#/components/features/hands/hands-labels";

const linkClassName =
  "text-xs text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** Sessions that need a person: a plan or PR to approve, or a PR to review. */
export default function HandsReviews() {
  const { t, i18n } = useTranslation("openhands");
  const { data, isLoading, isError, error, refetch } = useHandsSessions();
  const waiting = (data ?? []).filter((session) =>
    needsHumanReview(session.state),
  );

  let list: React.ReactNode;
  if (isLoading) {
    list = (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  } else if (isError && !data) {
    list = (
      <div
        role="alert"
        data-testid="hands-reviews-error"
        className="flex flex-col items-start gap-3"
      >
        <p className="text-sm text-danger">{handsErrorMessage(t, error)}</p>
        <BrandButton
          type="button"
          variant="secondary"
          onClick={() => refetch()}
        >
          {t(I18nKey.HANDS$RETRY)}
        </BrandButton>
      </div>
    );
  } else if (!waiting.length) {
    list = (
      <div
        data-testid="hands-reviews-empty"
        className={extensionModuleEmptyStateClassName}
      >
        <p className="text-sm text-contrast">
          {t(I18nKey.HANDS$REVIEWS_EMPTY)}
        </p>
      </div>
    );
  } else {
    list = (
      <ul
        data-testid="hands-reviews-list"
        aria-label={t(I18nKey.HANDS$REVIEWS_TITLE)}
        className="flex flex-col gap-2"
      >
        {waiting.map((session) => (
          <li
            key={session.id}
            data-testid={`hands-review-row-${session.id}`}
            className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-base-secondary px-4 py-3"
          >
            <div className="min-w-0 flex-1 basis-64">
              <p className="truncate text-sm font-medium text-content">
                {taskTitle(session.request.task)}
              </p>
              <p className="mt-0.5 truncate text-xs text-muted">
                {repoFolderName(session.repoDir)}
                {" · "}
                {t(I18nKey.HANDS$UPDATED, {
                  time: formatRelativeTime(session.updatedAt, i18n.language, t),
                })}
              </p>
            </div>
            <NavigationLink
              to={`/hands/sessions/${encodeURIComponent(session.id)}/review`}
              className={linkClassName}
            >
              {t(I18nKey.HANDS$REVIEW_OPEN)}
            </NavigationLink>
            {session.pr && (
              <a
                href={session.pr.url}
                target="_blank"
                rel="noreferrer"
                className={linkClassName}
              >
                {t(I18nKey.HANDS$PR_LINK, { number: session.pr.number })}
              </a>
            )}
            <HandsStateBadge state={session.state} />
          </li>
        ))}
      </ul>
    );
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-6 p-6">
        <div className="flex flex-col gap-3">
          <div>
            <h1 className="text-xl font-semibold text-content">
              {t(I18nKey.HANDS$REVIEWS_TITLE)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t(I18nKey.HANDS$REVIEWS_SUBTITLE)}
            </p>
          </div>
          <HandsSectionNav />
        </div>
        {list}
      </div>
    </div>
  );
}
