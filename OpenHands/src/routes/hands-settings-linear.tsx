import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useHandsSettings } from "#/hooks/query/use-hands";
import { BrandButton } from "#/components/features/settings/brand-button";
import { HandsLinearForm } from "#/components/features/hands/settings/hands-linear-form";

export default function HandsSettingsLinear() {
  const { t } = useTranslation("openhands");
  const { data, isLoading, refetch } = useHandsSettings();

  if (data) return <HandsLinearForm settings={data} />;
  if (isLoading) {
    return (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  }
  return (
    <div
      role="alert"
      data-testid="hands-linear-settings-load-error"
      className="flex flex-col items-start gap-3"
    >
      <p className="text-sm text-danger">{t(I18nKey.HANDS$LOAD_ERROR)}</p>
      <BrandButton type="button" variant="secondary" onClick={() => refetch()}>
        {t(I18nKey.HANDS$RETRY)}
      </BrandButton>
    </div>
  );
}
