# Bossku Hands

Windows-first, local-first autonomous coding desktop built on OpenHands Agent
Canvas. Describe a goal once; Hands plans, codes, reviews, opens a draft PR,
watches CI while the app is open, repairs failures within a budget, and stops
at "ready for human review". It never merges.

## Layout

| Path | What it is |
|---|---|
| `OpenHands/` | The app: upstream OpenHands/OpenHands at `e1b8b60f` (19 Nov 2026), tracked as plain files, plus the Hands changes |
| `OpenHands/scripts/hands/` | Hands orchestrator, git, GitHub, agent-runner and local API |
| `OpenHands/src/**/hands*` | Hands screens, hooks and API client |
| `docs/hands/` | `BRIEF.md` (design and owner rules), `STATUS.md` (what works, what is not verified) |
| `docs/legacy-logs/` | Logs from the first build, which was lost because it was never committed |
| `vendor/` | Reference submodules pinned to upstream commits (`git submodule update --init`) |

## Run

```powershell
cd OpenHands
npm ci
npm run dev
```

The stack starts the agent-server (18000), automation (18001), Hands (18002)
and the app behind one ingress. The desktop app (`npm run build:desktop`)
serves on **8100**; set `BOSSKU_HANDS_APP_PORT` to move it.

Hands needs, in the environment of the launcher:

- `BOSSKU_HANDS_GITHUB_TOKEN` (or `GITHUB_TOKEN` / `GH_TOKEN`): a token that can
  open pull requests and read checks on the target repos. Pushing uses your
  normal git credentials.
- An agent profile chosen per role in **Settings > Hands workflow**.
- Optional, for the Linear inbox: `BOSSKU_HANDS_LINEAR_API_KEY` (or
  `LINEAR_API_KEY`), and a repository per Linear team in **Settings > Linear
  teams**. An issue moves to Done only after its PR is really merged.

**Settings > Connections** checks both tokens and can add Microsoft
Edge (Playwright MCP) as the agents' browser. Tokens are never typed into
the app in this version.

`BOSSKU_HANDS=0` turns Hands off. Its state lives in
`~/.openhands/agent-canvas/hands/`.

## Check it

```powershell
cd OpenHands
npx vitest run __tests__/scripts/hands
npm run download-uv
node tests/hands-live/run.mjs
```

The last command is a live end-to-end run: the real agent-server, the Hands
sidecar and the ingress, a scripted mock LLM, a fake GitHub API and a real git
repository with a local push target. It uses ports 18390-18399 and a temp
folder, and never touches `~/.openhands`. After building the Docker image,
`node tests/hands-live/docker.mjs` runs the same flow inside the container
against a host repository mounted at `/projects` (host port 18500).

## Docker

See [docs/hands/DOCKER.md](docs/hands/DOCKER.md): one container, repositories
mounted at `/projects`, app on `127.0.0.1:8100`.

## Upstream

`OpenHands/` keeps upstream's history out of this repo on purpose: it is a
snapshot. To take a newer upstream, download that commit, diff it against the
snapshot commit and re-apply the Hands changes. `vendor/` pins the matching
software-agent-sdk, extensions, automation and Bossku-Superpowers commits.
