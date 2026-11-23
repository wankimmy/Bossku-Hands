import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsCiFailure } from "#/api/hands/hands-types";

interface HandsCiFailuresProps {
  failures: HandsCiFailure[] | undefined;
  defaultOpen?: boolean;
}

/** Last CI failures, collapsed unless the caller needs them in view. */
export function HandsCiFailures({
  failures,
  defaultOpen = false,
}: HandsCiFailuresProps) {
  const { t } = useTranslation("openhands");
  if (!failures?.length) return null;
  return (
    <details
      data-testid="hands-ci-failures"
      open={defaultOpen}
      className="rounded-xl border border-border p-3"
    >
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus">
        {t(I18nKey.HANDS$CI_FAILURES_HEADING)} ({failures.length})
      </summary>
      <ul className="mt-2 flex flex-col gap-2">
        {failures.map((failure, index) => (
          <li key={`${failure.name}-${index}`} className="text-sm">
            <span className="font-medium">{failure.name}</span>
            <span className="text-muted"> ({failure.conclusion})</span>
            {failure.summary && (
              <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-raised p-2 text-xs">
                {failure.summary}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
