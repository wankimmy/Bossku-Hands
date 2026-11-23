# Bossku Hands status

Updated 23 Nov 2026. Base: upstream OpenHands/OpenHands `e1b8b60f`.

## What works (tested)

| Area | Files | Evidence |
|---|---|---|
| Orchestrator state machine: plan, approval gates, code, independent review, draft PR (existing-PR check), CI repair loop, Auto Fix CI modes, budget (default 3), same-failure and infra escalation, reviewer-edit revert, cancel, shutdown suspend, crash recovery, resume, retry, merge detection, no-CI grace | `scripts/hands/orchestrator.mjs`, `ci-failure.mjs`, `prompts.mjs`, `session-store.mjs`, `git.mjs` | `__tests__/scripts/hands/orchestrator.test.ts` (real git repos in temp folders) |
| **Command guard**: every agent action waits for Hands (AlwaysConfirm; large batches are read page by page). Shell commands are split (pipes, `&&`, `;`, `$(...)`, backticks, comments, `bash -c`, `cmd /c`, `powershell -c/-co/-Command`, `find -exec`, `xargs`, `env -S`, `npx -c`, `uv run`/`poetry run`/`bundle exec`/`pnpm dlx`; real here-document bodies are text). Each command must be on an allow list of normal dev tools (or a script inside the worktree), and every argument that names a path (including `--x=path`, `-o../x`, `>&file`, `file:` URLs) must resolve inside the worktree, following symlinks and junctions. Git writes and network stay with Hands; `gh` is read-only (no `api` writes, no `auth` tokens); no uploads (`--json`, `-d`, `-F`, POST); no secrets (credential files, secret variables, `printenv`, `/proc/*/environ`, `~/.openhands`); no git/loader env overrides; no global installs, sudo, remote shells, links outside, system changes, privileged or host-network Docker. Browser: http(s) only; Playwright's evaluate, run-code, file-upload, storage and route tools refused. Planner, reviewer and "Suggest fixes" cannot write (file tools, redirects, writers, installs). A refused action goes back to the agent with the reason (and the allowed actions of that batch that did not run); 20 refusals stop the stage | `scripts/hands/command-guard.mjs`, `agent-runner.mjs` | `command-guard.test.ts` (211 cases, incl. one per finding of the independent review and a real junction), `agent-runner.test.ts`, live tests |
| Independent review (23 Nov 2026) of all new code: 3 P0 and 6 P1 guard bypasses plus 7 P2 items, all fixed with regression tests; server, auth, push and askpass found clean | | review report in the session; regressions in the test files above |
| Secret masking in CI logs, errors and agent output; credentials stripped from remote URLs; secret-looking files never committed | `ci-failure.mjs`, `git.mjs` | orchestrator tests |
| Agents cannot push: inside the worktree `protocol.allow=never` blocks every git transport and every remote URL is rewritten to a blocked scheme; the guard refuses git network commands. Hands pushes from your main checkout | `git.mjs` | orchestrator tests (named remote, ad-hoc path URL), live tests |
| Hands' tokens never reach agents: the launcher and the Docker entrypoint start the agent-server and other services without `BOSSKU_HANDS_GITHUB_TOKEN` / `BOSSKU_HANDS_LINEAR_API_KEY`; only the Hands sidecar gets them | `scripts/dev-with-automation.mjs`, `docker/entrypoint.sh` | `dev-with-automation.test.ts`, Docker live test reads the agent-server's `/proc/<pid>/environ` |
| GitHub REST: find/open draft PR, PR state, check runs, Actions job-log tail, account check, rate limit and token errors | `scripts/hands/github.mjs` | `github.test.ts` |
| **Linear**: inbox of your open assigned issues, start a session from an issue in the team's mapped repository (issue text read from Linear, one active session per issue), Done only after GitHub reports the real merge (team's Done state or its first completed state), once, with a warning and Retry on failure; per-team settings | `scripts/hands/linear.mjs`, orchestrator | `linear.test.ts`, orchestrator Linear tests |
| **Connections**: live check of the GitHub and Linear tokens (account name only, never the token) | orchestrator, `server.mjs` | orchestrator and server tests |
| **Edge browser**: one click adds Microsoft Edge through Playwright MCP 0.0.85 (pinned) to the agent-server's MCP settings; the guard allows only its `browser_*` tools | `scripts/hands/edge-browser.mjs` | `edge-browser.test.ts` |
| **Changes**: committed diff of a session branch (files, +/- counts, unified diff, cut at 400 KB); external diff drivers never run | `git.mjs`, orchestrator | orchestrator tests |
| Clean-up after a merge: the session's agent conversations are closed first (on Windows their terminals hold the folder), then the worktree is removed; a failure is a warning | orchestrator, `agent-runner.mjs`, `git.mjs` | orchestrator tests, live test on Windows |
| Local API on 127.0.0.1:18002: session key, loopback Host only, body limit, error codes; Linear, connections, browser and diff routes | `scripts/hands/server.mjs` | `server.test.ts` |
| Launcher starts Hands after the agent-server and routes `/api/hands`; `BOSSKU_HANDS=0` turns it off | `scripts/dev-with-automation.mjs` | `dev-with-automation.test.ts`, live test |
| UI: Sessions, Reviews and Linear tabs; session detail with execution graph (React Flow; a stage list on phones), Linear section, warnings, approve/cancel/resume/retry; review studio (changed files, diff, plan, AI notes, approve); Linear inbox; Settings > Hands workflow, Linear teams, Connections; 16 languages | `src/routes/hands-*.tsx`, `src/components/features/hands/` | `__tests__/routes/hands-*.test.tsx`; mock mode in a browser: no sideways scroll at 320 px on all 8 Hands pages, start-from-Linear, review studio, Add Edge checked by hand |
| **Live end-to-end run** (real agent-server 1.62.0, Hands sidecar and ingress; scripted mock LLM; fake GitHub API; real git repo with a local push target): plan, both approvals, code, the agent's own push refused by the guard, review, draft PR, CI green, merge, worktree removed | `tests/hands-live/run.mjs` | passes on Windows, 10 of 10 checks |
| Docker image with Hands; repositories mounted at `/projects`; Hands' https pushes use the GitHub token through an askpass helper that answers only `github.com` | `docker/Dockerfile`, `docker/entrypoint.sh`, `docker/compose.hands.yml`, `git.mjs` | image built; `tests/hands-live/docker.mjs` passes, 10 of 10 checks (the agent edits the mounted host repo, the guard refuses its push, Hands pushes with the token through askpass, which refuses a GitLab prompt, worktree removed, the agent-server process holds no Hands token) |
| Desktop app on port 8100, packaged as "Bossku Hands" (own appId, so it never replaces an official Agent Canvas install); Hands' packages ship in the installed app | `electron/main.mjs`, `electron-builder.config.mjs` | `electron-builder-config.test.ts` (imports the Hands packages from a simulated packaged app); `npm run build:desktop` builds `dist-electron/Bossku-Hands-Setup-1.42.0.exe` (unsigned) and the unpacked app loads the Hands server and its packages |
| Verify-skill route map: families F30-F33 cover every Hands route | `.agents/skills/verify-openhands/references/feature-map/` | map check and coverage: 41 routes, 0 unmapped |
| Windows fixes for upstream: 23 test failures; `download-uv` / `download-node` picked Git's GNU tar, which cannot open `C:\` paths | `scripts/download-arch-utils.mjs` and others | affected tests pass |

## Not verified live

- A run with a real LLM and real GitHub (real PR, real Actions). Every model reply in the live tests is scripted; every GitHub call goes to a fake.
- Linear against the real Linear API.
- Edge driven by a real agent through Playwright MCP.
- The installed desktop app on a clean machine.

## Known risks

- The guard is a filter, not a sandbox: code inside a script the agent writes and then runs (`node x.js`, `python -c`) is not inspected, and data can still leave through a plain GET request (for example in a query string). Docker mode is the stronger boundary.
- The allow list can refuse a tool a project really needs; the agent gets the reason, and the list lives in `command-guard.mjs` (`ALLOWED`).
- Agents run with your user account in desktop mode, like Canvas local mode.
- The push block sets `extensions.worktreeConfig = true` in each repo Hands works on.
- Tokens come from environment variables only. `BOSSKU_HANDS_*` tokens are kept from agents, but a system-wide `GITHUB_TOKEN` / `GH_TOKEN` / `LINEAR_API_KEY` is inherited by agents' shells too; use the `BOSSKU_HANDS_*` names. Do not store Hands tokens in the agent-server secrets store: agent profiles with `secret_refs: null` pass every stored secret to agents.

## Known limits

- `sessions.json` is rewritten on every event and never pruned.
- Escalated, failed and cancelled sessions keep their worktree for inspection; `hands/*` branches are never deleted.
- The worktree branches from the local base branch; Hands does not fetch first.
- In Docker, worktrees are recorded in your repo's `.git/worktrees` with container paths until the PR merges.
- The diff view is not keyboard-scrollable for very wide lines.

## Not rebuilt yet (from the master prompt)

Needs the owner's spec again (the full text was lost with the earlier context): Models & Roles with adaptive effort, the Clef decision gate, Bossku Superpowers install and skill evidence. Needs the owner's decision: how the Connections page should store tokens. Needs the owner's certificate: code signing.
