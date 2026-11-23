import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { useNavigation } from "#/context/navigation-context";
import { useStartHandsSession } from "#/hooks/mutation/use-hands-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import { SettingsInput } from "#/components/features/settings/settings-input";
import { formControlMultilineFieldClassName } from "#/utils/form-control-classes";
import { handsErrorMessage } from "../hands-labels";

export function HandsNewTaskForm() {
  const { t } = useTranslation("openhands");
  const { navigate } = useNavigation();
  const start = useStartHandsSession();
  const [task, setTask] = React.useState("");
  const [repoDir, setRepoDir] = React.useState("");
  const [baseBranch, setBaseBranch] = React.useState("");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const branch = baseBranch.trim();
    start.mutate(
      {
        task: task.trim(),
        repoDir: repoDir.trim(),
        ...(branch ? { baseBranch: branch } : {}),
      },
      {
        onSuccess: (session) =>
          navigate(`/hands/sessions/${encodeURIComponent(session.id)}`),
      },
    );
  };

  return (
    <form
      data-testid="hands-new-task-form"
      onSubmit={submit}
      aria-label={t(I18nKey.HANDS$NEW_TASK)}
      className="flex flex-col gap-4 rounded-xl border border-border p-4"
    >
      <h2 className="text-base font-semibold text-foreground">
        {t(I18nKey.HANDS$NEW_TASK)}
      </h2>
      <label className="flex flex-col gap-2.5">
        <span className="text-sm">{t(I18nKey.HANDS$TASK_LABEL)}</span>
        <textarea
          data-testid="hands-task-input"
          value={task}
          onChange={(e) => setTask(e.target.value)}
          rows={4}
          required
          className={formControlMultilineFieldClassName}
        />
      </label>
      <SettingsInput
        testId="hands-repo-input"
        label={t(I18nKey.HANDS$REPO_LABEL)}
        type="text"
        value={repoDir}
        onChange={setRepoDir}
        required
      />
      <SettingsInput
        testId="hands-base-branch-input"
        label={t(I18nKey.HANDS$BASE_BRANCH_LABEL)}
        type="text"
        value={baseBranch}
        onChange={setBaseBranch}
      />
      {start.isError && (
        <p
          role="alert"
          data-testid="hands-start-error"
          className="text-sm text-danger"
        >
          {handsErrorMessage(t, start.error)}
        </p>
      )}
      <div>
        <BrandButton
          testId="hands-start-task"
          type="submit"
          variant="primary"
          isDisabled={start.isPending}
          aria-busy={start.isPending}
        >
          {start.isPending
            ? t(I18nKey.HANDS$STARTING)
            : t(I18nKey.HANDS$START_TASK)}
        </BrandButton>
      </div>
    </form>
  );
}
