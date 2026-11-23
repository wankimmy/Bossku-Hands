import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import type { HandsLinearIssue } from "#/api/hands/hands-types";
import { useStartLinearIssue } from "#/hooks/mutation/use-hands-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import { NavigationLink } from "#/components/shared/navigation-link";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { handsErrorMessage, linearPriorityLabel } from "../hands-labels";

const linkClassName =
  "text-sm text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus";

/** One Linear issue, with a start action or a link to its running session. */
export function LinearIssueRow({ issue }: { issue: HandsLinearIssue }) {
  const { t, i18n } = useTranslation("openhands");
  const start = useStartLinearIssue();
  const startedId = start.data?.id;
  const inProgressSessionId =
    start.error instanceof HandsApiError &&
    start.error.code === "linear_issue_in_progress"
      ? start.error.sessionId
      : null;

  return (
    <li
      data-testid={`hands-linear-issue-${issue.identifier}`}
      className="flex flex-col gap-2 rounded-xl bg-base-secondary px-4 py-3"
    >
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-sm font-medium text-content">
          {issue.identifier}
        </span>
        <span className="min-w-0 break-words text-sm text-content">
          {issue.title}
        </span>
      </div>
      <p className="text-xs text-muted">
        {[
          issue.team?.key,
          issue.state?.name,
          linearPriorityLabel(t, issue.priority),
          t(I18nKey.HANDS$UPDATED, {
            time: formatRelativeTime(issue.updatedAt, i18n.language, t),
          }),
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {issue.session ? (
          <NavigationLink
            to={`/hands/sessions/${encodeURIComponent(issue.session.id)}`}
            className={linkClassName}
          >
            {t(I18nKey.HANDS$LINEAR_OPEN_SESSION)}
          </NavigationLink>
        ) : (
          <BrandButton
            type="button"
            variant="secondary"
            isDisabled={!issue.mapped || start.isPending}
            onClick={() => start.mutate({ issueId: issue.id })}
          >
            {start.isPending
              ? t(I18nKey.HANDS$STARTING)
              : t(I18nKey.HANDS$LINEAR_START_SESSION)}
          </BrandButton>
        )}
        {!issue.session && !issue.mapped && (
          <>
            <span className="text-xs text-muted">
              {t(I18nKey.HANDS$LINEAR_TEAM_NOT_MAPPED, {
                team: issue.team?.key ?? "",
              })}
            </span>
            <NavigationLink
              to="/settings/hands-linear"
              className={linkClassName}
            >
              {t(I18nKey.HANDS$LINEAR_SET_UP_TEAM)}
            </NavigationLink>
          </>
        )}
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className={linkClassName}
        >
          {t(I18nKey.HANDS$OPEN_IN_LINEAR)}
        </a>
      </div>

      {start.isSuccess && startedId && (
        <p role="status" className="flex flex-wrap gap-2 text-sm">
          <span>{t(I18nKey.HANDS$LINEAR_SESSION_STARTED)}</span>
          {/* The row links to the session once the inbox has refreshed. */}
          {!issue.session && (
            <NavigationLink
              to={`/hands/sessions/${encodeURIComponent(startedId)}`}
              className={linkClassName}
            >
              {t(I18nKey.HANDS$LINEAR_OPEN_SESSION)}
            </NavigationLink>
          )}
        </p>
      )}
      {start.isError && (
        <div role="alert" className="flex flex-col gap-1 text-sm text-danger">
          <p>{handsErrorMessage(t, start.error)}</p>
          {inProgressSessionId && (
            <NavigationLink
              to={`/hands/sessions/${encodeURIComponent(inProgressSessionId)}`}
              className={linkClassName}
            >
              {t(I18nKey.HANDS$LINEAR_OPEN_SESSION)}
            </NavigationLink>
          )}
        </div>
      )}
    </li>
  );
}
