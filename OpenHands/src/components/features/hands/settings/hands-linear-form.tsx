import React from "react";
import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type {
  HandsLinearIssue,
  HandsLinearTeamSettings,
  HandsSettings,
} from "#/api/hands/hands-types";
import { useUpdateHandsSettings } from "#/hooks/mutation/use-hands-mutations";
import { useLinearIssues, useLinearTeamStates } from "#/hooks/query/use-hands";
import { BrandButton } from "#/components/features/settings/brand-button";
import { formControlSettingsFieldClassName } from "#/utils/form-control-classes";
import { handsErrorMessage } from "../hands-labels";

const TEAM_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/;

interface TeamRow {
  key: string;
  teamId: string | null;
  name: string;
  repoDir: string;
  baseBranch: string;
  doneStateId: string | null;
}

type TeamEdit = Partial<Omit<TeamRow, "key">>;

const rowFromSettings = (
  key: string,
  saved: HandsLinearTeamSettings | undefined,
  issue: HandsLinearIssue | undefined,
): TeamRow => ({
  key,
  teamId: issue?.team?.id ?? null,
  name: issue?.team?.name ?? key,
  repoDir: saved?.repoDir ?? "",
  baseBranch: saved?.baseBranch ?? "",
  doneStateId: saved?.doneStateId ?? null,
});

/** The Done-state select for one team; it loads only once the team id is known. */
function DoneStateSelect({
  teamId,
  value,
  onChange,
  testId,
}: {
  teamId: string | null;
  value: string | null;
  onChange: (value: string | null) => void;
  testId: string;
}) {
  const { t } = useTranslation("openhands");
  const states = useLinearTeamStates(teamId);
  const label = t(I18nKey.HANDS$LINEAR_DONE_STATE);

  if (!teamId) {
    return (
      <label className="flex flex-col gap-2">
        <span className="text-sm">{label}</span>
        <select
          data-testid={testId}
          disabled
          value={value ?? ""}
          className={formControlSettingsFieldClassName}
        >
          <option value="">
            {t(I18nKey.HANDS$LINEAR_DONE_FIRST_COMPLETED)}
          </option>
        </select>
        <span className="text-xs text-muted">
          {t(I18nKey.HANDS$LINEAR_DONE_NEEDS_ISSUES)}
        </span>
      </label>
    );
  }

  const loaded = states.data ?? [];
  const hasValue =
    value !== null && !loaded.some((state) => state.id === value);
  return (
    <label className="flex flex-col gap-2">
      <span className="text-sm">{label}</span>
      <select
        data-testid={testId}
        disabled={!states.data}
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : event.target.value)
        }
        className={formControlSettingsFieldClassName}
      >
        <option value="">{t(I18nKey.HANDS$LINEAR_DONE_FIRST_COMPLETED)}</option>
        {hasValue && <option value={value}>{value}</option>}
        {loaded.map((state) => (
          <option key={state.id} value={state.id}>
            {state.name}
          </option>
        ))}
      </select>
      {states.isPending && (
        <span className="text-xs text-muted">
          {t(I18nKey.HANDS$LINEAR_DONE_LOADING)}
        </span>
      )}
      {states.isError && (
        <span role="alert" className="text-xs text-danger">
          {t(I18nKey.HANDS$LINEAR_DONE_LOAD_ERROR)}
        </span>
      )}
    </label>
  );
}

/** Repository folder, base branch and Done state for each Linear team. */
export function HandsLinearForm({ settings }: { settings: HandsSettings }) {
  const { t } = useTranslation("openhands");
  const issues = useLinearIssues();
  const save = useUpdateHandsSettings();
  const [edits, setEdits] = React.useState<Record<string, TeamEdit>>({});
  const [extraKeys, setExtraKeys] = React.useState<string[]>([]);
  const [removedKeys, setRemovedKeys] = React.useState<string[]>([]);
  const [newKey, setNewKey] = React.useState("");
  const [keyError, setKeyError] = React.useState<I18nKey | null>(null);
  const [saved, setSaved] = React.useState(false);

  const issueByTeam = new Map<string, HandsLinearIssue>();
  for (const issue of issues.data ?? []) {
    if (issue.team && !issueByTeam.has(issue.team.key)) {
      issueByTeam.set(issue.team.key, issue);
    }
  }
  const savedTeams = settings.linear?.teams ?? {};
  const keys = [
    ...new Set([
      ...Object.keys(savedTeams),
      ...issueByTeam.keys(),
      ...extraKeys,
    ]),
  ].filter((key) => !removedKeys.includes(key));

  const rows = keys.map((key) => ({
    ...rowFromSettings(key, savedTeams[key], issueByTeam.get(key)),
    ...edits[key],
  }));

  const updateRow = (key: string, patch: TeamEdit) => {
    setSaved(false);
    setEdits((current) => ({
      ...current,
      [key]: { ...current[key], ...patch },
    }));
  };

  const addTeam = () => {
    const key = newKey.trim();
    if (!TEAM_KEY_PATTERN.test(key)) {
      setKeyError(I18nKey.HANDS$LINEAR_TEAM_KEY_INVALID);
      return;
    }
    if (keys.includes(key)) {
      setKeyError(I18nKey.HANDS$LINEAR_TEAM_EXISTS);
      return;
    }
    setKeyError(null);
    setRemovedKeys((current) => current.filter((item) => item !== key));
    setExtraKeys((current) => [...current, key]);
    setNewKey("");
  };

  const removeTeam = (key: string) => {
    setSaved(false);
    setRemovedKeys((current) => [...current, key]);
    setExtraKeys((current) => current.filter((item) => item !== key));
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const teams = Object.fromEntries(
      rows.map((row) => [
        row.key,
        {
          repoDir: row.repoDir.trim() || null,
          baseBranch: row.baseBranch.trim() || null,
          doneStateId: row.doneStateId,
        },
      ]),
    );
    save.mutate({ linear: { teams } }, { onSuccess: () => setSaved(true) });
  };

  return (
    <form
      data-testid="hands-linear-form"
      onSubmit={submit}
      className="flex max-w-2xl flex-col gap-6"
    >
      <p className="text-sm text-muted">
        {t(I18nKey.HANDS$LINEAR_SETTINGS_INTRO)}
      </p>

      {rows.length === 0 && (
        <p className="text-sm text-muted">{t(I18nKey.HANDS$LINEAR_NO_TEAMS)}</p>
      )}

      {rows.map((row) => (
        <section
          key={row.key}
          data-testid={`hands-linear-team-${row.key}`}
          aria-labelledby={`hands-linear-team-title-${row.key}`}
          className="flex flex-col gap-4 rounded-xl border border-border p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3
              id={`hands-linear-team-title-${row.key}`}
              className="text-sm font-semibold"
            >
              {row.name}{" "}
              <span className="font-normal text-muted">({row.key})</span>
            </h3>
            <BrandButton
              type="button"
              variant="secondary"
              onClick={() => removeTeam(row.key)}
            >
              {t(I18nKey.HANDS$LINEAR_REMOVE_TEAM)}
            </BrandButton>
          </div>
          <label className="flex flex-col gap-2">
            <span className="text-sm">
              {t(I18nKey.HANDS$LINEAR_REPO_FOLDER)}
            </span>
            <input
              type="text"
              value={row.repoDir}
              onChange={(event) =>
                updateRow(row.key, { repoDir: event.target.value })
              }
              className={formControlSettingsFieldClassName}
            />
          </label>
          <label className="flex flex-col gap-2">
            <span className="text-sm">
              {t(I18nKey.HANDS$LINEAR_BASE_BRANCH)}
            </span>
            <input
              type="text"
              value={row.baseBranch}
              onChange={(event) =>
                updateRow(row.key, { baseBranch: event.target.value })
              }
              className={formControlSettingsFieldClassName}
            />
          </label>
          <DoneStateSelect
            testId={`hands-linear-done-${row.key}`}
            teamId={row.teamId}
            value={row.doneStateId}
            onChange={(value) => updateRow(row.key, { doneStateId: value })}
          />
        </section>
      ))}

      <div className="flex flex-col gap-2">
        <div role="group" className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-0 flex-1 basis-40 flex-col gap-2">
            <span className="text-sm">
              {t(I18nKey.HANDS$LINEAR_TEAM_KEY_LABEL)}
            </span>
            <input
              type="text"
              value={newKey}
              onChange={(event) => setNewKey(event.target.value)}
              onKeyDown={(event) => {
                // Enter adds the team here, not the save.
                if (event.key === "Enter") {
                  event.preventDefault();
                  addTeam();
                }
              }}
              className={formControlSettingsFieldClassName}
              aria-invalid={!!keyError}
            />
          </label>
          <BrandButton
            type="button"
            variant="secondary"
            onClick={() => addTeam()}
          >
            {t(I18nKey.HANDS$LINEAR_ADD_TEAM)}
          </BrandButton>
        </div>
        {keyError && (
          <p role="alert" className="text-xs text-danger">
            {t(keyError)}
          </p>
        )}
      </div>

      {save.isError && (
        <p
          role="alert"
          data-testid="hands-linear-error"
          className="text-sm text-danger"
        >
          {handsErrorMessage(t, save.error)}
        </p>
      )}
      {saved && (
        <p role="status" data-testid="hands-linear-saved" className="text-sm">
          {t(I18nKey.HANDS$SETTINGS_SAVED)}
        </p>
      )}
      <div>
        <BrandButton
          testId="hands-linear-save"
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
