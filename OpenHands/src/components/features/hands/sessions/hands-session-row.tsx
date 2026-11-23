import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSession } from "#/api/hands/hands-types";
import { NavigationLink } from "#/components/shared/navigation-link";
import { formatRelativeTime } from "#/utils/format-relative-time";
import { repoFolderName, taskTitle } from "../hands-labels";
import { HandsStateBadge } from "./hands-state-badge";

export function HandsSessionRow({ session }: { session: HandsSession }) {
  const { t, i18n } = useTranslation("openhands");
  return (
    <li
      data-testid={`hands-session-row-${session.id}`}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-base-secondary px-4 py-3"
    >
      <div className="min-w-0 flex-1 basis-64">
        <NavigationLink
          to={`/hands/sessions/${encodeURIComponent(session.id)}`}
          className="block truncate text-sm font-medium text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {taskTitle(session.request.task)}
        </NavigationLink>
        <p className="mt-0.5 truncate text-xs text-muted">
          {repoFolderName(session.repoDir)}
          {" · "}
          {t(I18nKey.HANDS$UPDATED, {
            time: formatRelativeTime(session.updatedAt, i18n.language, t),
          })}
        </p>
      </div>
      {session.pr && (
        <a
          href={session.pr.url}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t(I18nKey.HANDS$PR_LINK, { number: session.pr.number })}
        </a>
      )}
      <HandsStateBadge state={session.state} />
    </li>
  );
}
