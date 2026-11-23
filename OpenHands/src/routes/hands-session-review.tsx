import { useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import {
  useHandsSession,
  useHandsSessionDiff,
  isTerminalHandsState,
} from "#/hooks/query/use-hands";
import { useApproveHandsSession } from "#/hooks/mutation/use-hands-mutations";
import { BackNavButton } from "#/components/shared/buttons/back-nav-button";
import { NavigationLink } from "#/components/shared/navigation-link";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsStateBadge } from "#/components/features/hands/sessions/hands-state-badge";
import { HandsDiffView } from "#/components/features/hands/review/hands-diff-view";
import {
  HANDS_APPROVAL_TITLE_KEYS,
  HANDS_APPROVE_BUTTON_KEYS,
  handsErrorMessage,
  repoFolderName,
  taskTitle,
} from "#/components/features/hands/hands-labels";

const sectionClassName =
  "flex min-w-0 flex-col gap-2 rounded-xl border border-border p-4";
const preClassName =
  "max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3 text-sm text-contrast";

/** Changed files, the diff, the plan, AI notes and the pending approval. */
export default function HandsSessionReview() {
  const { t } = useTranslation("openhands");
  const { sessionId } = useParams<{ sessionId: string }>();
  const session = useHandsSession(sessionId);
  const data = session.data;
  const diff = useHandsSessionDiff(
    sessionId,
    data ? !isTerminalHandsState(data.state) : true,
  );
  const approve = useApproveHandsSession();

  const back = (
    <BackNavButton to="/hands/reviews">
      {t(I18nKey.HANDS$BACK_TO_REVIEWS)}
    </BackNavButton>
  );

  if (!data) {
    return (
      <div className="min-h-full">
        <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
          <div>{back}</div>
          {session.isError ? (
            <p role="alert" className="text-sm text-danger">
              {handsErrorMessage(t, session.error)}
            </p>
          ) : (
            <p role="status" className="text-sm text-muted">
              {t(I18nKey.HANDS$LOADING)}
            </p>
          )}
        </div>
      </div>
    );
  }

  const gate = data.pendingApproval;
  const awaitingGate = data.state === "AWAITING_APPROVAL" && !!gate;

  let changes: React.ReactNode;
  if (diff.isError) {
    changes = (
      <p role="alert" className="text-sm text-danger">
        {t(I18nKey.HANDS$DIFF_LOAD_ERROR)}
      </p>
    );
  } else if (!diff.data) {
    changes = (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  } else if (!diff.data.files.length) {
    changes = (
      <p className="text-sm text-muted">{t(I18nKey.HANDS$NO_CHANGES)}</p>
    );
  } else {
    changes = (
      <>
        <section
          aria-labelledby="hands-review-files-title"
          className={sectionClassName}
        >
          <h2 id="hands-review-files-title" className="text-sm font-medium">
            {t(I18nKey.HANDS$CHANGED_FILES)} ({diff.data.files.length})
          </h2>
          <ul className="flex flex-col gap-1">
            {diff.data.files.map((file) => (
              <li
                key={file.path}
                data-testid={`hands-review-file-${file.path}`}
                className="flex flex-wrap items-center justify-between gap-2 text-sm"
              >
                <span className="min-w-0 break-all font-mono text-xs">
                  {file.path}
                </span>
                {file.additions === null || file.deletions === null ? (
                  <span className="text-xs text-muted">
                    {t(I18nKey.HANDS$DIFF_BINARY)}
                  </span>
                ) : (
                  <span className="shrink-0 font-mono text-xs">
                    <span className="text-content">+{file.additions}</span>{" "}
                    <span className="text-danger">-{file.deletions}</span>
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        <HandsDiffView diff={diff.data} />
      </>
    );
  }

  return (
    <div className="min-h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 p-6">
        <div>{back}</div>
        <header className="flex flex-col gap-2">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <h1 className="min-w-0 break-words text-xl font-semibold text-content">
              {t(I18nKey.HANDS$REVIEW_STUDIO_TITLE)}:{" "}
              {taskTitle(data.request.task)}
            </h1>
            <HandsStateBadge state={data.state} />
          </div>
          <p className="text-xs text-muted">
            {repoFolderName(data.repoDir)} · {data.baseBranch}
          </p>
          <div className="flex flex-wrap gap-4">
            {data.pr && (
              <a
                href={data.pr.url}
                target="_blank"
                rel="noreferrer"
                className="w-fit text-sm text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
              >
                {t(I18nKey.HANDS$PR_LINK, { number: data.pr.number })}
              </a>
            )}
            <NavigationLink
              to={`/hands/sessions/${encodeURIComponent(data.id)}`}
              className="w-fit text-sm text-contrast underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {t(I18nKey.HANDS$SESSION_DETAILS)}
            </NavigationLink>
          </div>
        </header>

        {awaitingGate && (
          <section
            aria-labelledby="hands-review-approve-title"
            className={sectionClassName}
          >
            <h2
              id="hands-review-approve-title"
              className="text-base font-semibold"
            >
              {t(HANDS_APPROVAL_TITLE_KEYS[gate])}
            </h2>
            {approve.isError && (
              <p role="alert" className="text-sm text-danger">
                {handsErrorMessage(t, approve.error)}
              </p>
            )}
            <div>
              <BrandButton
                testId="hands-review-approve"
                type="button"
                variant="primary"
                isDisabled={approve.isPending}
                onClick={() => approve.mutate({ id: data.id, gate })}
              >
                {t(HANDS_APPROVE_BUTTON_KEYS[gate])}
              </BrandButton>
            </div>
          </section>
        )}

        <section
          aria-labelledby="hands-review-plan-title"
          className={sectionClassName}
        >
          <h2 id="hands-review-plan-title" className="text-sm font-medium">
            {t(I18nKey.HANDS$PLAN_HEADING)}
          </h2>
          {data.plan ? (
            <pre className={preClassName}>{data.plan}</pre>
          ) : (
            <p className="text-sm text-muted">{t(I18nKey.HANDS$NO_PLAN)}</p>
          )}
        </section>

        <section
          aria-labelledby="hands-review-notes-title"
          className={sectionClassName}
        >
          <h2 id="hands-review-notes-title" className="text-sm font-medium">
            {t(I18nKey.HANDS$REVIEW_NOTES_HEADING)}
          </h2>
          {data.review ? (
            <>
              <p className="text-sm">
                {data.review.verdict === "APPROVE"
                  ? t(I18nKey.HANDS$REVIEW_APPROVE)
                  : t(I18nKey.HANDS$REVIEW_REQUEST_CHANGES)}
              </p>
              {data.review.notes && (
                <pre className={preClassName}>{data.review.notes}</pre>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">
              {t(I18nKey.HANDS$REVIEW_NO_NOTES)}
            </p>
          )}
        </section>

        {changes}
      </div>
    </div>
  );
}
