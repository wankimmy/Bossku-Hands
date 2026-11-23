# F32 — Bossku Hands review queue and review studio

The **Reviews** queue (`/hands/reviews`) lists only the sessions that need a person: those waiting for an approval (AWAITING_APPROVAL) and those ready for a human review (READY_FOR_HUMAN_REVIEW). Each row opens the **review studio** (`/hands/sessions/<id>/review`), which shows the session's changed files with line counts, a unified diff, the plan, the AI review notes, the PR link and, when a gate is waiting, the approve button for that gate. The queue and the studio read the local Hands service at `/api/hands/*`; the approval itself uses the same endpoint as the session page's approval panel (F30).

Source: `src/routes/hands-reviews.tsx`, `src/routes/hands-session-review.tsx`, `src/components/features/hands/review/`, `src/components/features/hands/hands-labels.ts`, `src/components/features/hands/hands-section-nav.tsx`.

## Sub-features

- `F32.entry-points`: the **Reviews** tab in the Hands section nav (`/hands/reviews`), the command menu entry **Reviews**, the **Open review** link on the session page (F30.detail, which lands here) and the **Open review** link in each queue row all lead to the studio or queue; the direct URLs work too.
- `F32.queue`: `/hands/reviews` shows `hands-reviews-list` with one `hands-review-row-<id>` per waiting session: the task title, the repository folder and "updated" time, an **Open review** link to the studio, the PR link (`#<number>`) when the session has a PR, and the state badge. A session in any other state does not appear.
- `F32.queue-empty`: with no waiting session, `hands-reviews-empty` says "Nothing needs your review right now."
- `F32.queue-error`: when the sessions cannot load and nothing is cached, `hands-reviews-error` (role `alert`) shows the message and a **Retry** button.
- `F32.studio-header`: `/hands/sessions/<id>/review` has the heading "Review: <task title>", the state badge, the repository folder and base branch, the PR link when one exists, a **Session details** link back to `/hands/sessions/<id>`, and a **Back to reviews** button (`BackNavButton`) to `/hands/reviews`. While the session loads it shows "Loading..."; if it cannot load, the error message.
- `F32.studio-files`: a **Changed files (n)** list with one `hands-review-file-<path>` row per file, showing `+additions` and `-deletions`. A binary file shows "binary" instead of counts. With no changes it says "No committed changes yet." and no file list.
- `F32.studio-diff`: the unified diff sits in `hands-diff` (a `pre` labelled "Diff"). Added lines have a success background, removed lines a fail background, hunk and file headers are muted, and every line keeps its sign so colour is not the only cue. A cut diff shows a `role="note"` with "The diff is too long, so it was cut short. Open the pull request to see all of it." A failed diff load shows an alert. The diff does not refresh once the session is in a terminal state.
- `F32.studio-plan-notes`: the **Plan** section shows the plan text or "No plan text was recorded."; the **Review notes** section shows the reviewer verdict ("The reviewer approved the changes." or "The reviewer requested changes.") and the notes, or "No review notes yet." when none exist.
- `F32.studio-approve`: while the session is AWAITING_APPROVAL with a pending gate, the approval section shows the gate's title and a `hands-review-approve` button labelled for that gate (plan, PR or push fix). A refused approval shows an alert with the reason. In every other state the section is absent. The gate rules are the ones in the session page's approval panel (F30, approval sub-feature).

## How to get to it (user POV)

- The **Reviews** tab in the Hands section nav (reached from **Sessions** or **Linear**), or the command menu **Reviews**.
- **Open review** on a queue row, or the **Open review** link on the session page (`/hands/sessions/<id>`).
- Direct URLs `/hands/reviews` and `/hands/sessions/<id>/review`.

## Driving it with control-openhands

Preconditions:

- Baseline state (launched, doctored, `onboard --skip` done). The Hands service must be running (`control-openhands api GET /api/hands/sessions`).
- A session in AWAITING_APPROVAL or READY_FOR_HUMAN_REVIEW. Create one with the flow in F30 (`QA_` task text on `fixture git-repo --name qa-hands-repo`) and stop at its first gate. In mock mode the seeded sessions cover the queue; check `control-openhands api GET /api/hands/sessions` to see which states exist.
- Desktop viewport unless a bullet says otherwise.

- **Entry points (`F32.entry-points`).** `control-openhands browser goto /hands/reviews`, then `control-openhands browser click 'role=navigation >> role=link[name="Reviews"][exact]' --expect-url '/hands/reviews(\?|$)'` from the Sessions page. From a session page, `control-openhands browser click 'role=link[name="Open review"][exact]' --expect-url '/hands/sessions/[^/]+/review'`.
- **Queue (`F32.queue`).** On `/hands/reviews`, `control-openhands browser count '[data-testid^="hands-review-row-"]'` matches the number of sessions in the two waiting states from `control-openhands api GET /api/hands/sessions`. Each row has an **Open review** link. A session in any other state must not appear: for a COMPLETED or CODING session's id, `control-openhands browser count 'testid=hands-review-row-<id>'` is `0`.
- **Queue empty and error (`F32.queue-empty`, `F32.queue-error`).** With no waiting session, `control-openhands browser text 'testid=hands-reviews-empty'`. With the service stopped (only for a run this run started), `control-openhands browser text 'testid=hands-reviews-error'`; restart the service afterwards. Otherwise record the error row `blocked`.
- **Studio header (`F32.studio-header`).** Click **Open review** on a row (`--expect-url '/hands/sessions/[^/]+/review'`). `control-openhands browser text 'role=heading[level=1]'` starts with "Review:". The state badge is shown. Click **Session details** with `--expect-url '/hands/sessions/[^/]+$'`. Back on the studio, click **Back to reviews** with `--expect-url '/hands/reviews'`.
- **Files and counts (`F32.studio-files`).** On the studio, `control-openhands browser count '[data-testid^="hands-review-file-"]'` equals the number of entries in `files` from `control-openhands api GET /api/hands/sessions/<id>/diff`. Read `browser text 'testid=hands-review-file-<path>'` for a file with `+`/`-` counts. A session with no change: `control-openhands browser text 'role=main'` contains "No committed changes yet.".
- **Diff (`F32.studio-diff`).** `control-openhands browser count 'testid=hands-diff'` is `1`; `control-openhands browser snapshot 'testid=hands-diff'` shows the patch. Lines starting with `+` and `-` carry the colour classes (read with `control-openhands browser eval`, not by eye). For a truncated diff, `control-openhands browser text 'role=note'` shows the cut-short sentence; blocked when the fixture diff is small.
- **Plan and notes (`F32.studio-plan-notes`).** The Plan section text equals `control-openhands api GET /api/hands/sessions/<id> --pick plan` (or the "No plan" sentence when empty). The review section shows the verdict and notes from `review`, or "No review notes yet." before the reviewer runs.
- **Approve (`F32.studio-approve`).** When the session is AWAITING_APPROVAL, `control-openhands browser count 'testid=hands-review-approve'` is `1`. Click it, `control-openhands browser wait 'testid=hands-review-approve' --state detached --timeout 30000`, then read the state with `control-openhands api GET /api/hands/sessions/<id>`. Approve only the gate the section names. In any other state `control-openhands browser count 'testid=hands-review-approve'` is `0`. Never approve a session whose repository is not a `fixture git-repo` copy: a PR gate can open a real PR.
- **Phone (`F32.queue`).** `control-openhands browser viewport phone`, then `control-openhands browser bbox 'role=main'` on `/hands/reviews` and the studio: `pageHorizontalOverflow` is `false`; the diff scrolls inside its own box. Return with `control-openhands browser viewport desktop`.

## Gotchas

- The queue and the studio show only waiting states; a session that just finished leaves the queue on the next refetch, so re-read the queue before asserting its count.
- The studio's **Open review** link on a session page is the only way to reach it from that page; the approval panel on the session page (F30) and the studio button are two surfaces for the same gate.
- The diff is fetched only while the session is not in a terminal state; a finished session shows the last diff it had, which is correct.
- Mock mode (`src/mocks/hands-handlers.ts`) serves the queue and diff from seeded sessions but never opens a real PR; rows that need a real PR link or a real gate effect are `blocked` there.
- Review and approval error texts are service-sent and not translated; assert on test ids and roles.
