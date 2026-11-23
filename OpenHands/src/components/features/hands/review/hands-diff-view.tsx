import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSessionDiff } from "#/api/hands/hands-types";
import { cn } from "#/utils/utils";

/** Colour by line kind; the leading sign also says it, so colour is not alone. */
function lineClassName(line: string) {
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted";
  if (line.startsWith("@@")) return "text-muted";
  if (line.startsWith("+")) return "bg-status-success-bg text-content";
  if (line.startsWith("-")) return "bg-status-fail-bg text-content";
  return "text-content";
}

/** A unified diff. Only the code block scrolls sideways, not the page. */
export function HandsDiffView({ diff }: { diff: HandsSessionDiff }) {
  const { t } = useTranslation("openhands");
  const lines = diff.patch.split("\n");
  return (
    <div className="flex min-w-0 flex-col gap-2">
      {diff.truncated && (
        <p role="note" className="text-sm text-muted">
          {t(I18nKey.HANDS$DIFF_TRUNCATED)}
        </p>
      )}
      <pre
        data-testid="hands-diff"
        role="region"
        aria-label={t(I18nKey.HANDS$DIFF_LABEL)}
        // A scrollable region must be focusable so keyboard users can scroll
        // wide lines (WCAG 2.1.1, axe scrollable-region-focusable).
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
        tabIndex={0}
        className="max-w-full overflow-x-auto rounded-lg border border-border bg-surface-raised p-3 font-mono text-xs leading-5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {lines.map((line, index) => (
          <span
            // A patch can repeat lines, so the position is the key.
            key={index}
            className={cn("block whitespace-pre px-1", lineClassName(line))}
          >
            {line || " "}
          </span>
        ))}
      </pre>
    </div>
  );
}
