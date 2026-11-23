import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import { NavigationLink } from "#/components/shared/navigation-link";
import { cn } from "#/utils/utils";

const SECTION_LINKS: ReadonlyArray<{ to: string; label: I18nKey }> = [
  { to: "/hands/sessions", label: I18nKey.HANDS$NAV_SESSIONS },
  { to: "/hands/reviews", label: I18nKey.HANDS$NAV_REVIEWS },
  { to: "/hands/linear", label: I18nKey.HANDS$NAV_LINEAR },
];

/** Tabs that move between the Hands pages. */
export function HandsSectionNav() {
  const { t } = useTranslation("openhands");
  return (
    <nav
      aria-label={t(I18nKey.HANDS$SECTION_NAV_LABEL)}
      className="flex flex-wrap gap-2"
    >
      {SECTION_LINKS.map((link) => (
        <NavigationLink
          key={link.to}
          to={link.to}
          className={({ isActive }) =>
            cn(
              "rounded-full px-3 py-1 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
              isActive
                ? "bg-surface-raised font-medium text-content"
                : "text-muted hover:text-content",
            )
          }
        >
          {t(link.label)}
        </NavigationLink>
      ))}
    </nav>
  );
}
