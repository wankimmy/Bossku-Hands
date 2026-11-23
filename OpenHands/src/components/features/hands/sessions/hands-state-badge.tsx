import { useTranslation } from "react-i18next";
import type { HandsSessionState } from "#/api/hands/hands-types";
import { cn } from "#/utils/utils";
import { HANDS_STATE_LABEL_KEYS } from "../hands-labels";

interface HandsStateBadgeProps {
  state: HandsSessionState;
  testId?: string;
}

/** State shown as text, so meaning never depends on colour alone. */
export function HandsStateBadge({ state, testId }: HandsStateBadgeProps) {
  const { t } = useTranslation("openhands");
  const needsAttention =
    state === "AWAITING_APPROVAL" ||
    state === "ESCALATED" ||
    state === "FAILED" ||
    state === "READY_FOR_HUMAN_REVIEW";
  return (
    <span
      data-testid={testId}
      data-state={state}
      className={cn(
        "inline-flex shrink-0 items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
        needsAttention
          ? "border border-contrast text-contrast"
          : "bg-surface-raised text-tertiary-light",
      )}
    >
      {t(HANDS_STATE_LABEL_KEYS[state])}
    </span>
  );
}
