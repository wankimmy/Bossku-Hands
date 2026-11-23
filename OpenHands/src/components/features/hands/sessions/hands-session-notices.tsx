import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { TFunction } from "i18next";
import type { HandsSession, HandsWarning } from "#/api/hands/hands-types";
import { HANDS_STATE_LABEL_KEYS, escalationSentence } from "../hands-labels";

const noticeClassName = "rounded-xl border border-border p-4 text-sm";

/** One plain sentence that says what happened, per warning code. */
function warningSentence(warning: HandsWarning, t: TFunction) {
  if (warning.code === "commands_blocked") {
    return t(I18nKey.HANDS$WARNING_COMMANDS_BLOCKED);
  }
  if (warning.code === "secret_files_skipped") {
    return t(I18nKey.HANDS$WARNING_SECRET_FILES_SKIPPED);
  }
  if (warning.code === "reviewer_changed_files") {
    return t(I18nKey.HANDS$WARNING_REVIEWER_CHANGED_FILES);
  }
  if (warning.code === "linear_sync_failed") {
    return t(I18nKey.HANDS$WARNING_LINEAR_SYNC_FAILED);
  }
  if (warning.code === "worktree_cleanup_failed") {
    return t(I18nKey.HANDS$WARNING_WORKTREE_CLEANUP_FAILED);
  }
  return t(I18nKey.HANDS$WARNING_OTHER, { code: warning.code });
}

/** Outcome text for finished or waiting states, in plain sentences. */
export function HandsSessionNotices({ session }: { session: HandsSession }) {
  const { t } = useTranslation("openhands");
  const { state, escalation, failure, warnings } = session;

  return (
    <>
      {state === "READY_FOR_HUMAN_REVIEW" && (
        <p
          role="status"
          data-testid="hands-ready-notice"
          className={noticeClassName}
        >
          {t(I18nKey.HANDS$READY_FOR_HUMAN)}
        </p>
      )}
      {state === "COMPLETED" && (
        <p
          role="status"
          data-testid="hands-completed-notice"
          className={noticeClassName}
        >
          {t(I18nKey.HANDS$COMPLETED_MERGED)}
        </p>
      )}
      {escalation && (
        <section
          data-testid="hands-escalation"
          aria-labelledby="hands-escalation-title"
          className={noticeClassName}
        >
          <h2 id="hands-escalation-title" className="font-semibold">
            {t(I18nKey.HANDS$ESCALATED_HEADING)}
          </h2>
          <p className="mt-1">{escalationSentence(t, escalation.reason)}</p>
          {escalation.detail && (
            <pre
              data-testid="hands-escalation-detail"
              className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-3"
            >
              {escalation.detail}
            </pre>
          )}
        </section>
      )}
      {state === "FAILED" && failure && (
        <section data-testid="hands-failure" className={noticeClassName}>
          <p role="alert" className="font-semibold">
            {t(I18nKey.HANDS$FAILED_DURING, {
              stage: t(HANDS_STATE_LABEL_KEYS[failure.stage]),
            })}
          </p>
          <p className="mt-1 break-words">{failure.message}</p>
        </section>
      )}
      {warnings.length > 0 && (
        <section data-testid="hands-warnings" className={noticeClassName}>
          <h2 className="font-semibold">{t(I18nKey.HANDS$WARNINGS_HEADING)}</h2>
          {warnings.map((warning, index) => (
            <div
              key={`${warning.code}-${warning.at}-${index}`}
              className="mt-2"
            >
              <p>{warningSentence(warning, t)}</p>
              {warning.message && (
                <p className="break-words text-muted">{warning.message}</p>
              )}
              <ul className="list-inside list-disc break-all text-muted">
                {warning.files.map((file) => (
                  <li key={file}>{file}</li>
                ))}
                {(warning.actions ?? []).map((item, itemIndex) => (
                  <li key={`${item.action}-${itemIndex}`}>
                    <code>{item.action}</code>: {item.reason}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
    </>
  );
}
