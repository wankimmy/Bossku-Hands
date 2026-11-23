import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useHandsSessions } from "#/hooks/query/use-hands";
import { HandsNewTaskForm } from "#/components/features/hands/sessions/hands-new-task-form";
import { HandsSessionRow } from "#/components/features/hands/sessions/hands-session-row";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsSectionNav } from "#/components/features/hands/hands-section-nav";
import { extensionModuleEmptyStateClassName } from "#/utils/extension-module-card-classes";

export default function HandsSessions() {
  const { t } = useTranslation("openhands");
  const { data, isLoading, isError, refetch } = useHandsSessions();

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
        data-testid="hands-sessions-error"
        className="flex flex-col items-start gap-3"
      >
        <p className="text-sm text-danger">{t(I18nKey.HANDS$LOAD_ERROR)}</p>
        <BrandButton
          type="button"
          variant="secondary"
          onClick={() => refetch()}
        >
          {t(I18nKey.HANDS$RETRY)}
        </BrandButton>
      </div>
    );
  } else if (!data?.length) {
    list = (
      <div
        data-testid="hands-sessions-empty"
        className={extensionModuleEmptyStateClassName}
      >
        <p className="text-sm text-contrast">{t(I18nKey.HANDS$EMPTY)}</p>
      </div>
    );
  } else {
    list = (
      <ul
        data-testid="hands-sessions-list"
        aria-label={t(I18nKey.HANDS$SESSIONS_TITLE)}
        className="flex flex-col gap-2"
      >
        {data.map((session) => (
          <HandsSessionRow key={session.id} session={session} />
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
              {t(I18nKey.HANDS$SESSIONS_TITLE)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t(I18nKey.HANDS$SESSIONS_SUBTITLE)}
            </p>
          </div>
          <HandsSectionNav />
        </div>
        <HandsNewTaskForm />
        {list}
      </div>
    </div>
  );
}
