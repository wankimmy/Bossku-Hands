import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import type {
  HandsAutoFixMode,
  HandsRole,
  HandsSettings,
} from "#/api/hands/hands-types";
import { useUpdateHandsSettings } from "#/hooks/mutation/use-hands-mutations";
import { useAgentProfiles } from "#/hooks/query/use-agent-profiles";
import { BrandButton } from "#/components/features/settings/brand-button";
import { SettingsInput } from "#/components/features/settings/settings-input";
import { SettingsSwitch } from "#/components/features/settings/settings-switch";
import { formControlSettingsFieldClassName } from "#/utils/form-control-classes";
import { HANDS_AUTO_FIX_OPTIONS, handsErrorMessage } from "../hands-labels";

const ROLE_LABEL_KEYS: ReadonlyArray<{ role: HandsRole; label: I18nKey }> = [
  { role: "planner", label: I18nKey.HANDS$ROLE_PLANNER },
  { role: "coder", label: I18nKey.HANDS$ROLE_CODER },
  { role: "reviewer", label: I18nKey.HANDS$ROLE_REVIEWER },
];

// The select's value for "Not chosen"; it maps to `null` on save.
const NOT_CHOSEN = "";

interface FormState {
  gates: HandsSettings["gates"];
  autoFixCi: HandsAutoFixMode;
  ciRepairBudget: string;
  maxReviewRounds: string;
  ciPollSeconds: string;
  roles: HandsSettings["roles"];
}

const toFormState = (settings: HandsSettings): FormState => ({
  gates: settings.gates,
  autoFixCi: settings.autoFixCi,
  ciRepairBudget: String(settings.ciRepairBudget),
  maxReviewRounds: String(settings.maxReviewRounds),
  ciPollSeconds: String(settings.ciPollIntervalMs / 1000),
  roles: settings.roles,
});

// An empty or non-numeric field becomes NaN, which JSON sends as null, so the
// server rejects it and names the field.
const toNumber = (value: string) => (value.trim() === "" ? NaN : Number(value));

export function HandsWorkflowForm({ settings }: { settings: HandsSettings }) {
  const { t } = useTranslation("openhands");
  const save = useUpdateHandsSettings();
  const { data: profileList } = useAgentProfiles();
  const [form, setForm] = React.useState(() => toFormState(settings));
  const [saved, setSaved] = React.useState(false);

  const update = (patch: Partial<FormState>) => {
    setSaved(false);
    setForm((current) => ({ ...current, ...patch }));
  };

  const profiles = (profileList?.profiles ?? []).map((profile) => ({
    value: profile.id ?? profile.name,
    label: profile.name,
  }));

  const serverField =
    save.error instanceof HandsApiError &&
    save.error.code === "invalid_settings"
      ? save.error.field
      : null;
  const fieldError = (...names: string[]) =>
    serverField && names.includes(serverField)
      ? t(I18nKey.HANDS$FIELD_INVALID)
      : undefined;

  const autoFixError = fieldError("autoFixCi");
  const roleFieldError = (role: HandsRole) =>
    fieldError(`roles.${role}`, "roles");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const seconds = toNumber(form.ciPollSeconds);
    save.mutate(
      {
        gates: form.gates,
        autoFixCi: form.autoFixCi,
        ciRepairBudget: toNumber(form.ciRepairBudget),
        maxReviewRounds: toNumber(form.maxReviewRounds),
        ciPollIntervalMs: Math.round(seconds * 1000),
        roles: form.roles,
      },
      { onSuccess: () => setSaved(true) },
    );
  };

  return (
    <form
      data-testid="hands-workflow-form"
      onSubmit={submit}
      className="flex max-w-2xl flex-col gap-6"
    >
      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-medium">
          {t(I18nKey.HANDS$APPROVALS_LEGEND)}
        </legend>
        <SettingsSwitch
          testId="hands-gate-approve-plan"
          isToggled={form.gates.approve_plan}
          onToggle={(value) =>
            update({ gates: { ...form.gates, approve_plan: value } })
          }
        >
          {t(I18nKey.HANDS$GATE_APPROVE_PLAN)}
        </SettingsSwitch>
        <SettingsSwitch
          testId="hands-gate-open-pr"
          isToggled={form.gates.open_pr}
          onToggle={(value) =>
            update({ gates: { ...form.gates, open_pr: value } })
          }
        >
          {t(I18nKey.HANDS$GATE_OPEN_PR)}
        </SettingsSwitch>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="mb-3 text-sm font-medium">
          {t(I18nKey.HANDS$AUTO_FIX_LEGEND)}
        </legend>
        {HANDS_AUTO_FIX_OPTIONS.map((option) => (
          <div
            key={option.mode}
            className="flex items-start gap-3 rounded-sm has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-focus"
          >
            <input
              type="radio"
              id={`hands-auto-fix-${option.mode}`}
              name="hands-auto-fix-ci"
              value={option.mode}
              checked={form.autoFixCi === option.mode}
              aria-describedby={`hands-auto-fix-${option.mode}-desc`}
              onChange={() => update({ autoFixCi: option.mode })}
              className="mt-1"
            />
            <div className="flex flex-col">
              <label
                htmlFor={`hands-auto-fix-${option.mode}`}
                className="cursor-pointer text-sm"
              >
                {t(option.label)}
              </label>
              <p
                id={`hands-auto-fix-${option.mode}-desc`}
                className="text-xs text-muted"
              >
                {t(option.description)}
              </p>
            </div>
          </div>
        ))}
        {autoFixError && (
          <p role="alert" className="text-xs text-danger">
            {autoFixError}
          </p>
        )}
      </fieldset>

      <div className="flex flex-col gap-4">
        <SettingsInput
          testId="hands-ci-repair-budget"
          label={t(I18nKey.HANDS$CI_REPAIR_BUDGET)}
          type="number"
          min={0}
          max={10}
          step={1}
          value={form.ciRepairBudget}
          onChange={(value) => update({ ciRepairBudget: value })}
          error={fieldError("ciRepairBudget")}
        />
        <SettingsInput
          testId="hands-max-review-rounds"
          label={t(I18nKey.HANDS$MAX_REVIEW_ROUNDS)}
          type="number"
          min={1}
          max={5}
          step={1}
          value={form.maxReviewRounds}
          onChange={(value) => update({ maxReviewRounds: value })}
          error={fieldError("maxReviewRounds")}
        />
        <SettingsInput
          testId="hands-ci-poll-seconds"
          label={t(I18nKey.HANDS$CI_POLL_INTERVAL)}
          type="number"
          min={0}
          max={3600}
          step={1}
          value={form.ciPollSeconds}
          onChange={(value) => update({ ciPollSeconds: value })}
          error={fieldError("ciPollIntervalMs")}
        />
      </div>

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-3 text-sm font-medium">
          {t(I18nKey.HANDS$ROLES_LEGEND)}
        </legend>
        {ROLE_LABEL_KEYS.map(({ role, label }) => {
          const current = form.roles[role];
          const options =
            current && !profiles.some((p) => p.value === current)
              ? [...profiles, { value: current, label: current }]
              : profiles;
          const roleError = roleFieldError(role);
          return (
            <label key={role} className="flex flex-col gap-2.5">
              <span className="text-sm">{t(label)}</span>
              <select
                data-testid={`hands-role-${role}`}
                value={current ?? NOT_CHOSEN}
                aria-invalid={!!roleError}
                onChange={(e) =>
                  update({
                    roles: {
                      ...form.roles,
                      [role]:
                        e.target.value === NOT_CHOSEN ? null : e.target.value,
                    },
                  })
                }
                className={formControlSettingsFieldClassName}
              >
                <option value={NOT_CHOSEN}>
                  {t(I18nKey.HANDS$ROLE_NOT_CHOSEN)}
                </option>
                {options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {roleError && (
                <p role="alert" className="-mt-1 text-xs text-danger">
                  {roleError}
                </p>
              )}
            </label>
          );
        })}
      </fieldset>

      {save.isError && (
        <p
          role="alert"
          data-testid="hands-settings-error"
          className="text-sm text-danger"
        >
          {handsErrorMessage(t, save.error)}
        </p>
      )}
      {saved && (
        <p role="status" data-testid="hands-settings-saved" className="text-sm">
          {t(I18nKey.HANDS$SETTINGS_SAVED)}
        </p>
      )}
      <div>
        <BrandButton
          testId="hands-settings-save"
          type="submit"
          variant="primary"
          isDisabled={save.isPending}
          aria-busy={save.isPending}
        >
          {save.isPending
            ? t(I18nKey.HANDS$SETTINGS_SAVING)
            : t(I18nKey.HANDS$SETTINGS_SAVE)}
        </BrandButton>
      </div>
    </form>
  );
}
