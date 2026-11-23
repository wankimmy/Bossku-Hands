import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useLinearIssues } from "#/hooks/query/use-hands";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsSectionNav } from "#/components/features/hands/hands-section-nav";
import { LinearIssueRow } from "#/components/features/hands/linear/linear-issue-row";
import { handsErrorMessage } from "#/components/features/hands/hands-labels";
import { extensionModuleEmptyStateClassName } from "#/utils/extension-module-card-classes";

export default function HandsLinear() {
  const { t } = useTranslation("openhands");
  const { data, isLoading, isError, error, refetch } = useLinearIssues();

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
        data-testid="hands-linear-error"
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
  } else if (!data?.length) {
    list = (
      <div
        data-testid="hands-linear-empty"
        className={extensionModuleEmptyStateClassName}
      >
        <p className="text-sm text-contrast">{t(I18nKey.HANDS$LINEAR_EMPTY)}</p>
      </div>
    );
  } else {
    list = (
      <ul
        data-testid="hands-linear-list"
        aria-label={t(I18nKey.HANDS$LINEAR_TITLE)}
        className="flex flex-col gap-2"
      >
        {data.map((issue) => (
          <LinearIssueRow key={issue.id} issue={issue} />
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
              {t(I18nKey.HANDS$LINEAR_TITLE)}
            </h1>
            <p className="mt-1 text-sm text-muted">
              {t(I18nKey.HANDS$LINEAR_SUBTITLE)}
            </p>
          </div>
          <HandsSectionNav />
        </div>
        {list}
      </div>
    </div>
  );
}
