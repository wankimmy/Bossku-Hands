import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useHandsSession } from "#/hooks/query/use-hands";
import { BackNavButton } from "#/components/shared/buttons/back-nav-button";
import { NavigationLink } from "#/components/shared/navigation-link";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsStateBadge } from "#/components/features/hands/sessions/hands-state-badge";
import { HandsApprovalPanel } from "#/components/features/hands/sessions/hands-approval-panel";
import { HandsSessionActions } from "#/components/features/hands/sessions/hands-session-actions";
import { HandsSessionNotices } from "#/components/features/hands/sessions/hands-session-notices";
import { HandsCiFailures } from "#/components/features/hands/sessions/hands-ci-failures";
import { HandsEventTimeline } from "#/components/features/hands/sessions/hands-event-timeline";
import { HandsExecutionGraph } from "#/components/features/hands/sessions/hands-execution-graph";
import { HandsLinearSection } from "#/components/features/hands/sessions/hands-linear-section";
import {
  handsErrorMessage,
  repoFolderName,
  taskTitle,
} from "#/components/features/hands/hands-labels";

export default function HandsSessionDetail() {
  const { t } = useTranslation("openhands");
  const { sessionId } = useParams<{ sessionId: string }>();
  const {
    data: session,
    isLoading,
    error,
    refetch,
  } = useHandsSession(sessionId);

  const back = (
    <BackNavButton to="/hands/sessions">
      {t(I18nKey.HANDS$BACK_TO_SESSIONS)}
    </BackNavButton>
  );

  let body: React.ReactNode;
  if (session) {
    const title = taskTitle(session.request.task);
    const showFullTask = session.request.task.trim() !== title;
    body = (
      <>
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="min-w-0 break-words text-xl font-semibold text-content">
              {title}
            </h1>
            <HandsStateBadge
              state={session.state}
              testId="hands-session-state"
            />
          </div>
          {showFullTask && (
            <p className="whitespace-pre-wrap break-words text-sm text-muted">
              {session.request.task}
            </p>
          )}
          <p className="text-xs text-muted">
            {t(I18nKey.HANDS$REPOSITORY_LINE, {
              repo: repoFolderName(session.repoDir),
              base: session.baseBranch,
            })}
          </p>
          {session.pr && (
            <a
              href={session.pr.url}
              target="_blank"
              rel="noreferrer"
              data-testid="hands-pr-link"
              className="w-fit text-sm text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t(I18nKey.HANDS$PR_LINK, { number: session.pr.number })}
            </a>
          )}
          <p data-testid="hands-ci-rounds" className="text-xs text-muted">
            {t(I18nKey.HANDS$CI_REPAIR_ROUNDS, {
              used: session.counters.ciRepairRounds,
              budget: session.settings.ciRepairBudget,
            })}
          </p>
        </header>
        <NavigationLink
          to={`/hands/sessions/${encodeURIComponent(session.id)}/review`}
          className="w-fit text-sm text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
        >
          {t(I18nKey.HANDS$REVIEW_OPEN)}
        </NavigationLink>
        <section
          aria-labelledby="hands-graph-title"
          className="flex flex-col gap-2"
        >
          <h2 id="hands-graph-title" className="text-sm font-medium">
            {t(I18nKey.HANDS$GRAPH_HEADING)}
          </h2>
          <HandsExecutionGraph session={session} />
        </section>
        <HandsLinearSection session={session} />
        <HandsApprovalPanel session={session} />
        <HandsSessionNotices session={session} />
        <HandsSessionActions session={session} />
        {session.pendingApproval !== "push_fix" && (
          <HandsCiFailures failures={session.lastCiFailures} />
        )}
        <HandsEventTimeline events={session.events} />
      </>
    );
  } else if (isLoading) {
    body = (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  } else {
    body = (
      <div
        role="alert"
        data-testid="hands-session-error"
        className="flex flex-col items-start gap-3"
      >
        <p className="text-sm text-danger">
          {error ? handsErrorMessage(t, error) : t(I18nKey.HANDS$LOAD_ERROR)}
        </p>
        <BrandButton
          type="button"
          variant="secondary"
          onClick={() => refetch()}
        >
          {t(I18nKey.HANDS$RETRY)}
        </BrandButton>
      </div>
    );
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <div>{back}</div>
        {body}
      </div>
    </div>
  );
}
