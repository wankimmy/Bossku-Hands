import { useTranslation } from "react-i18next";
import { I18nKey } from "#/i18n/declaration";
import type { HandsConnectionStatus } from "#/api/hands/hands-types";
import { useHandsBrowser, useHandsConnections } from "#/hooks/query/use-hands";
import { useAddEdgeBrowser } from "#/hooks/mutation/use-hands-mutations";
import { BrandButton } from "#/components/features/settings/brand-button";
import { handsCodeMessage, handsErrorMessage } from "../hands-labels";

const cardClassName = "flex flex-col gap-3 rounded-xl border border-border p-4";

function ConnectionCard({
  title,
  status,
}: {
  title: I18nKey;
  status: HandsConnectionStatus;
}) {
  const { t } = useTranslation("openhands");
  return (
    <section aria-labelledby={`hands-card-${title}`} className={cardClassName}>
      <h2 id={`hands-card-${title}`} className="text-sm font-semibold">
        {t(title)}
      </h2>
      {status.ok ? (
        <p className="text-sm">
          {t(I18nKey.HANDS$CONNECTED_AS, { account: status.account ?? "" })}
        </p>
      ) : (
        <p role="alert" className="text-sm text-danger">
          {handsCodeMessage(t, status.error ?? null)}
        </p>
      )}
    </section>
  );
}

/** GitHub and Linear status, plus the agent browser set-up. */
export function HandsConnectionsPanel() {
  const { t } = useTranslation("openhands");
  const connections = useHandsConnections();
  const browser = useHandsBrowser();
  const addEdge = useAddEdgeBrowser();

  let cards: React.ReactNode;
  if (connections.data) {
    cards = (
      <>
        <ConnectionCard
          title={I18nKey.HANDS$GITHUB_CARD}
          status={connections.data.github}
        />
        <ConnectionCard
          title={I18nKey.HANDS$LINEAR_CARD}
          status={connections.data.linear}
        />
      </>
    );
  } else if (connections.isError) {
    cards = (
      <p role="alert" className="text-sm text-danger">
        {handsErrorMessage(t, connections.error)}
      </p>
    );
  } else {
    cards = (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  }

  let browserBody: React.ReactNode;
  if (browser.data?.installed) {
    browserBody = (
      <p className="text-sm">{t(I18nKey.HANDS$AGENT_BROWSER_INSTALLED)}</p>
    );
  } else if (browser.data) {
    browserBody = (
      <>
        <p className="text-sm">
          {t(I18nKey.HANDS$AGENT_BROWSER_NOT_INSTALLED)}
        </p>
        <div>
          <BrandButton
            testId="hands-add-edge"
            type="button"
            variant="secondary"
            isDisabled={addEdge.isPending}
            onClick={() => addEdge.mutate()}
          >
            {t(I18nKey.HANDS$ADD_EDGE)}
          </BrandButton>
        </div>
      </>
    );
  } else {
    browserBody = (
      <p role="status" className="text-sm text-muted">
        {t(I18nKey.HANDS$LOADING)}
      </p>
    );
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      <div>
        <BrandButton
          testId="hands-check-again"
          type="button"
          variant="secondary"
          isDisabled={connections.isFetching}
          onClick={() => connections.refetch()}
        >
          {connections.isFetching
            ? t(I18nKey.HANDS$CHECKING)
            : t(I18nKey.HANDS$CHECK_AGAIN)}
        </BrandButton>
      </div>
      {cards}

      <section aria-labelledby="hands-card-browser" className={cardClassName}>
        <h2 id="hands-card-browser" className="text-sm font-semibold">
          {t(I18nKey.HANDS$AGENT_BROWSER_CARD)}
        </h2>
        {browserBody}
        {addEdge.isSuccess && (
          <p role="status" className="text-sm">
            {t(
              addEdge.data.added
                ? I18nKey.HANDS$ADD_EDGE_ADDED
                : I18nKey.HANDS$ADD_EDGE_ALREADY,
            )}
          </p>
        )}
        {addEdge.isError && (
          <p role="alert" className="text-sm text-danger">
            {handsErrorMessage(t, addEdge.error)}
          </p>
        )}
      </section>
    </div>
  );
}
