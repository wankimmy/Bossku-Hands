# Bossku Hands in Docker

One container runs the Agent Server, the automation backend, the Hands
sidecar and the web app. Your repositories are mounted at `/projects`, so
agents read, edit and run commands on your real files.

## Run it

From `OpenHands/`:

```powershell
npm run build:docker -- --tag bossku-hands:local
```

```powershell
$env:LOCAL_BACKEND_API_KEY = "<long random value>"
$env:BOSSKU_HANDS_PROJECTS = "C:\Users\me\code"
$env:BOSSKU_HANDS_GITHUB_TOKEN = "<token with repo access>"
docker compose -f docker/compose.hands.yml up
```

Open http://127.0.0.1:8100 and paste `LOCAL_BACKEND_API_KEY` when the app asks.
In Hands, start sessions on paths under `/projects` (for example
`/projects/my-app`).

## What is different from the desktop app

- **Pushes.** There is no Git Credential Manager in the container. Hands
  pushes over https with `BOSSKU_HANDS_GITHUB_TOKEN`, through an askpass
  helper that answers only `github.com` prompts. The token is passed to Hands'
  push command only, never to agents. SSH remotes need your own key setup.
- **Worktrees** live in the state volume
  (`/home/openhands/.openhands/agent-canvas/hands/worktrees`). Git records
  them in your repository's `.git/worktrees` with container paths; they are
  removed when the PR is merged, and `git worktree prune` on the host cleans
  up any that are left.
- **Ownership.** The entrypoint marks `/projects/*` as a git
  `safe.directory` inside the container, because the mounted files belong to
  your host user.
- **Port.** Published on `127.0.0.1:8100` only. Do not publish it on all
  interfaces.

## Check it

`node tests/hands-live/docker.mjs` (from `OpenHands/`, after the build) runs a
full session inside the container against a host repository mounted at
`/projects`, with a scripted mock LLM and a fake GitHub, and removes its
container afterwards.

## Turn Hands off

Set `BOSSKU_HANDS=0` in the container environment; the rest of the app runs
as before.
