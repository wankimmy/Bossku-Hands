import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsSessionEvent } from "#/api/hands/hands-types";

/** Event timeline, collapsed by default: it is advanced information. */
export function HandsEventTimeline({
  events,
}: {
  events: HandsSessionEvent[];
}) {
  const { t, i18n } = useTranslation("openhands");
  return (
    <details
      data-testid="hands-event-timeline"
      className="rounded-xl border border-border p-3"
    >
      <summary className="cursor-pointer text-sm font-medium focus-visible:outline-2 focus-visible:outline-focus">
        {t(I18nKey.HANDS$TIMELINE_HEADING)} ({events.length})
      </summary>
      {events.length === 0 ? (
        <p className="mt-2 text-sm text-muted">{t(I18nKey.HANDS$NO_EVENTS)}</p>
      ) : (
        <ol className="mt-2 flex flex-col gap-1 text-xs">
          {events.map((event, index) => (
            <li key={`${event.at}-${index}`} className="break-words">
              <time dateTime={event.at} className="text-muted">
                {new Date(event.at).toLocaleString(i18n.language)}
              </time>{" "}
              <span className="font-medium">{event.type}</span>
              {event.message && <span>{`: ${event.message}`}</span>}
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}
