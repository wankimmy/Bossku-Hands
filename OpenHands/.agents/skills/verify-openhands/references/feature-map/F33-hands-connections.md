# F33 — Bossku Hands connections and agent browser

**Connections** (`/settings/hands-connections`) shows whether Bossku Hands can reach GitHub and Linear. Each card says "Connected as <account>" or, when it cannot connect, a plain-language reason that names the environment variable to set. **Check again** re-reads the status. The **Agent browser** card says whether Microsoft Edge is set up for the agent's browser tool (Playwright MCP) and offers **Add Microsoft Edge** when it is not. The page reads `/api/hands/connections` and `/api/hands/browser`; the credentials themselves are never shown.

Source: `src/routes/hands-settings-connections.tsx`, `src/components/features/hands/settings/hands-connections-panel.tsx`, `src/components/features/hands/hands-labels.ts`, `src/constants/settings-nav.tsx`.

## Sub-features

- `F33.entry-points`: the Settings navigation entry **Connections** (`/settings/hands-connections`) and the command menu entry of the same name lead here; the direct URL works too.
- `F33.github-card`: the **GitHub** card (`aria-labelledby` heading "GitHub") shows "Connected as <account>" when the token works. Otherwise `role="alert"` shows the reason for the code: `github_token_missing` names `BOSSKU_HANDS_GITHUB_TOKEN`, `GITHUB_TOKEN` or `GH_TOKEN`; `github_token_invalid` says GitHub rejected the token; `github_rate_limited` asks to wait a few minutes; `github_request_failed` says GitHub could not be reached.
- `F33.linear-card`: the **Linear** card works the same way for Linear: "Connected as <account>", or the reason with `BOSSKU_HANDS_LINEAR_API_KEY` or `LINEAR_API_KEY` named for a missing or rejected key, rate-limit and unreachable messages.
- `F33.check-again`: **Check again** (`hands-check-again`) refetches both statuses. While the request runs its label reads "Checking..." and the button is disabled. A card that changes from error to connected after a key is set and the service restarted shows the new state after this click.
- `F33.agent-browser`: the **Agent browser** card shows either "Microsoft Edge is set up for the agent browser." or "Microsoft Edge is not set up for the agent browser yet." with **Add Microsoft Edge** (`hands-add-edge`). Clicking it disables the button while it runs; the result line says "Microsoft Edge was added to the agent's MCP settings." when it added the entry, or "Microsoft Edge was already set up." when nothing changed. A failure shows `role="alert"`.
- `F33.load-error`: when the connection status cannot load, the cards are replaced by an alert with the service message; while loading, a "Loading..." status is shown in each place.

## How to get to it (user POV)

- Settings navigation **Connections** (under the Hands entries, next to **Hands workflow** and **Linear teams**).
- The command menu, Settings group, **Connections**.
- The direct URL `/settings/hands-connections`.
- The Linear inbox's "Set up" path (F31) leads to Linear teams, not here; use this page to diagnose a missing key.

## Driving it with control-openhands

Preconditions:

- Baseline state (launched, doctored, `onboard --skip` done). The Hands service must be running (`control-openhands api GET /api/hands/connections`).
- For a "Connected as" result a real GitHub token and a real Linear key must be in the Hands service's environment before it starts. Without them the cards show their missing-key reasons, which is the expected keyless result. Never type a token into the UI or a command line.
- Adding Microsoft Edge changes the agent's MCP settings: it runs only on a run this verification owns, and its before and after state is read from `control-openhands api GET /api/hands/browser`. Restore it afterwards (remove the entry through the MCP settings page, F17, if the run added it).
- Desktop viewport unless a bullet says otherwise.

- **Entry point (`F33.entry-points`).** `control-openhands browser goto /settings/hands-connections`. From `/settings` the navigation reaches it: `control-openhands browser click 'role=navigation >> role=link[name="Connections"][exact]' --expect-url '/settings/hands-connections(\?|$)'`.
- **GitHub and Linear cards (`F33.github-card`, `F33.linear-card`).** `control-openhands browser text 'role=heading[name="GitHub"][exact]'` is followed by its status text. Compare with `control-openhands api GET /api/hands/connections`: `github.ok` true means "Connected as", false means the alert text for `github.error`. The same for `linear`. With no keys, `control-openhands browser text 'role=alert'` names the env variables from the code the API returned. Screenshot: `control-openhands browser screenshot --feature F33.github-card --name connections`.
- **Check again (`F33.check-again`).** Click `testid=hands-check-again`, read it back as "Checking..." while pending (`control-openhands browser wait 'testid=hands-check-again' --timeout 5000` then `control-openhands browser text 'testid=hands-check-again'`), and confirm one `GET /api/hands/connections` in `control-openhands browser network --last 20`. A status change needs the key or token changed and the service restarted; otherwise the result is the same and that is correct.
- **Agent browser (`F33.agent-browser`).** Read `control-openhands api GET /api/hands/browser`. If `installed` is false, the card says "not set up yet" and `testid=hands-add-edge` is enabled; click it, then `control-openhands browser wait 'testid=hands-add-edge' --state visible` and read the result line (added or already set up). Read the API again: `installed` is true. If `installed` is already true, the card shows "is set up" and no Add button (`control-openhands browser count 'testid=hands-add-edge'` is `0`). Blocked where Microsoft Edge is not installed on the machine: the service reports the failure and the alert shows it.
- **Load error (`F33.load-error`).** Only on a run that stopped the Hands service: `control-openhands browser goto /settings/hands-connections` shows `role=alert` with the service message in place of the cards. Restart the service afterwards. If the service is not under this run's control, record `blocked`.
- **Phone (`F33.github-card`).** `control-openhands browser viewport phone`, `control-openhands browser bbox 'role=main'`, `pageHorizontalOverflow` is `false`. Return with `control-openhands browser viewport desktop`.

## Gotchas

- A "Connected as" result comes only from real credentials; in mock mode (`src/mocks/hands-handlers.ts`) both cards start in the `linear_key_missing` state, and Add Microsoft Edge flips a mock flag, not the real MCP settings. Rows that need a real account are `blocked` in mock mode.
- Missing-key messages are the expected result on a keyless run; do not record them as failures of the card.
- Error texts name env variables by design, so asserting on these names is valid; the surrounding wording is service-sent and not translated.
- Adding Microsoft Edge writes to the agent's MCP settings, which later runs inherit; always restore it.
