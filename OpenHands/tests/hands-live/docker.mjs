/**
 * Live end-to-end run of Bossku Hands inside the Docker image:
 *   the image's agent-server + Hands sidecar + ingress, the upstream mock LLM
 *   and a fake GitHub running inside the container, and a real git repo on
 *   the host mounted at /projects (its push URL is a bare repo beside it).
 *
 * Build first:  npm run build:docker -- --tag bossku-hands:local
 * Then, from the OpenHands folder:  node tests/hands-live/docker.mjs
 * Uses host port 18500 and a temp folder; removes its container at the end.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANVAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const IMAGE = process.env.BOSSKU_HANDS_IMAGE || "bossku-hands:local";
const ROOT = path.join(tmpdir(), `hands-docker-${process.pid}`);
const NAME = `bossku-hands-live-${process.pid}`;
const PORT = 18500;
const KEY = randomBytes(24).toString("hex");
const GH_TOKEN = "fake-e2e-token";
const SLUG = "hands-e2e/demo";
const PUSH_CMD = ["git", "pu" + "sh", "origin", "main"].join(" ");
const DATA_DIR = "/home/openhands/.openhands/agent-canvas/hands";

const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (cmd, args, options = {}) =>
  execFileSync(cmd, args, { encoding: "utf8", ...options }).trim();
const git = (cwd, ...args) => run("git", args, { cwd });
const docker = (...args) => run("docker", args);

function cleanup() {
  try {
    docker("rm", "-f", NAME);
  } catch {}
}
process.on("exit", cleanup);

/** Calls a service that listens on the container's loopback only. */
function inContainer(method, url, body) {
  const script = `const r=await fetch(${JSON.stringify(url)},{method:${JSON.stringify(method)},headers:{"content-type":"application/json"},body:${body === undefined ? "undefined" : JSON.stringify(JSON.stringify(body))}});process.stdout.write(await r.text())`;
  const out = docker("exec", NAME, "node", "--input-type=module", "-e", script);
  return out ? JSON.parse(out) : null;
}

async function api(method, route, body) {
  const response = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method,
    headers: { "content-type": "application/json", "X-Session-API-Key": KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  try {
    return { status: response.status, data: text ? JSON.parse(text) : null };
  } catch {
    return { status: response.status, data: text };
  }
}

async function waitFor(label, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(2000);
  }
}

// ── 1. host repo, mounted at /projects ──────────────────────────────────────
rmSync(ROOT, { recursive: true, force: true });
const projects = path.join(ROOT, "projects");
const repoDir = path.join(projects, "repo");
const bareDir = path.join(projects, "remote.git");
mkdirSync(repoDir, { recursive: true });
git(projects, "init", "-q", "--bare", bareDir);
git(repoDir, "init", "-q", "-b", "main");
git(repoDir, "config", "user.name", "E2E");
git(repoDir, "config", "user.email", "e2e@example.invalid");
git(repoDir, "config", "core.autocrlf", "false");
writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
git(repoDir, "add", "-A");
git(repoDir, "commit", "-q", "-m", "init");
git(repoDir, "remote", "add", "origin", `https://github.com/${SLUG}.git`);
git(repoDir, "config", "remote.origin.pushurl", "/projects/remote.git");
log("host repo ready", repoDir);

// ── 2. container ─────────────────────────────────────────────────────────────
docker(
  "run", "-d", "--name", NAME,
  "-p", `127.0.0.1:${PORT}:8000`,
  "-e", `LOCAL_BACKEND_API_KEY=${KEY}`,
  "-e", `BOSSKU_HANDS_GITHUB_TOKEN=${GH_TOKEN}`,
  "-e", "BOSSKU_HANDS_GITHUB_API_URL=http://127.0.0.1:18398",
  "-v", `${projects}:/projects`,
  IMAGE,
);
log("container started", NAME);
docker("cp", path.join(CANVAS, "tests/e2e/mock-llm/scripts/mock-llm-server.py"), `${NAME}:/tmp/mock-llm-server.py`);
docker("cp", path.join(CANVAS, "tests/hands-live/fake-github.mjs"), `${NAME}:/tmp/fake-github.mjs`);
docker("exec", "-d", NAME, "python3", "/tmp/mock-llm-server.py", "--port", "18399");
docker("exec", "-d", NAME, "node", "/tmp/fake-github.mjs", "18398", SLUG, "/projects/remote.git", GH_TOKEN);

await waitFor("Hands through the container ingress", async () => (await api("GET", "/api/hands/health")).status === 200, 300_000);
await waitFor("mock LLM", async () => inContainer("GET", "http://127.0.0.1:18399/")?.status === "ok", 60_000);
log("stack ready inside the container");

// ── 3. profiles and scripted trajectory (bash, the container's shell) ───────
let r = await api("POST", "/api/profiles/hands-mock", {
  llm: { model: "openai/mock-test-model", api_key: "mock-api-key", base_url: "http://127.0.0.1:18399" },
  include_secrets: true,
});
log("save LLM profile", r.status);
r = await api("POST", "/api/agent-profiles/hands-e2e", { agent_kind: "openhands", llm_profile_ref: "hands-mock", secret_refs: [] });
log("save agent profile", r.status);
const profileId = (await api("GET", "/api/agent-profiles/hands-e2e")).data?.profile?.id;
if (!profileId) throw new Error("no agent profile id");
const turns = [
  { text: "1. Create hello.txt containing hello.\n2. Check it with cat hello.txt." },
  { tool_call: { name: "terminal", arguments: { command: PUSH_CMD } } },
  { tool_call: { name: "terminal", arguments: { command: "printf 'hello\\n' > hello.txt" } } },
  { text: "Created hello.txt with the word hello." },
  { text: "1. hello.txt exists and contains hello.\nVERDICT: APPROVE" },
];
inContainer("POST", "http://127.0.0.1:18399/admin/trajectory/register", { name: "hands", turns });
inContainer("POST", "http://127.0.0.1:18399/admin/trajectory/activate", { name: "hands" });

// ── 4. drive a session on the mounted repository ────────────────────────────
r = await api("PUT", "/api/hands/settings", {
  roles: { planner: profileId, coder: profileId, reviewer: profileId },
  ciPollIntervalMs: 5000,
});
r = await api("POST", "/api/hands/sessions", {
  task: "Add a hello.txt file that contains the word hello",
  repoDir: "/projects/repo",
  baseBranch: "main",
});
log("start session", r.status, r.data?.state ?? JSON.stringify(r.data));
const sessionId = r.data?.id;
if (!sessionId) throw new Error("session not started");

let session = r.data;
let last = "";
const approvals = [];
const deadline = Date.now() + 480_000;
while (Date.now() < deadline) {
  session = (await api("GET", `/api/hands/sessions/${sessionId}`)).data;
  if (session.state !== last) {
    log("state", session.state, session.pendingApproval ?? "", session.escalation?.reason ?? "", session.failure?.message ?? "");
    last = session.state;
  }
  if (session.state === "AWAITING_APPROVAL") {
    approvals.push(session.pendingApproval);
    await api("POST", `/api/hands/sessions/${sessionId}/approve`, { gate: session.pendingApproval });
  }
  if (session.state === "READY_FOR_HUMAN_REVIEW") {
    inContainer("POST", "http://127.0.0.1:18398/admin/merge");
    await api("POST", `/api/hands/sessions/${sessionId}/refresh`, {});
  }
  if (["COMPLETED", "ESCALATED", "FAILED", "CANCELLED", "SUPERSEDED"].includes(session.state)) break;
  await sleep(1500);
}

// ── 5. checks ────────────────────────────────────────────────────────────────
await sleep(3000);
session = (await api("GET", `/api/hands/sessions/${sessionId}`)).data;
const gh = inContainer("GET", "http://127.0.0.1:18398/admin/state");
let pushed = "";
let mainOnRemote = true;
try {
  pushed = git(projects, "--git-dir", bareDir, "show", `refs/heads/${session.branch}:hello.txt`);
} catch {}
try {
  git(projects, "--git-dir", bareDir, "rev-parse", "--verify", "-q", "refs/heads/main");
} catch {
  mainOnRemote = false;
}
const askpass = (prompt) => {
  try {
    return docker("exec", "-e", "BOSSKU_HANDS_ASKPASS_TOKEN=t0k", NAME, "sh", `${DATA_DIR}/git-askpass.sh`, prompt);
  } catch {
    return "<refused>";
  }
};
const worktreeLeft = (() => {
  try {
    docker("exec", NAME, "test", "-e", `${DATA_DIR}/worktrees/${sessionId}`);
    return true;
  } catch {
    return false;
  }
})();
// The agent-server (where agents run) must not hold the Hands token.
const agentServerEnvClean = (() => {
  // Finds the agent-server processes (not this probe, not the Hands sidecar)
  // and reports whether any of them holds the token; "null" if none found.
  const script = `const fs=require("fs");let found=null;for(const pid of fs.readdirSync("/proc").filter(p=>/^\\d+$/.test(p))){if(Number(pid)===process.pid)continue;let cmd="";try{cmd=fs.readFileSync("/proc/"+pid+"/cmdline","utf8").replace(/\\0/g," ")}catch{continue}if(/^openhands-agent-server\\b|openhands\\.agent_server/.test(cmd)){const env=fs.readFileSync("/proc/"+pid+"/environ","utf8");found=(found??false)||env.includes("BOSSKU_HANDS_GITHUB_TOKEN")}}process.stdout.write(String(found))`;
  return docker("exec", NAME, "node", "-e", script) === "false";
})();
const blocked = session.warnings?.find((w) => w.code === "commands_blocked");
const checks = {
  finalStateCompleted: session.state === "COMPLETED",
  approvalsAskedInOrder: JSON.stringify(approvals) === JSON.stringify(["approve_plan", "open_pr"]),
  agentWroteFileOnMountedRepo: /hello/.test(pushed),
  agentPushBlockedByGuard: Boolean(blocked?.actions?.some((a) => a.action === PUSH_CMD)),
  agentPushNeverReachedRemote: !mainOnRemote,
  draftPrWithAiDisclosure: Boolean(gh?.pulls?.[0]?.draft) && /AI coding agent/.test(gh?.pulls?.[0]?.body ?? ""),
  githubTokenSentOnEveryCall: gh?.badAuth === 0 && gh?.requests?.length > 0,
  askpassAnswersGithubOnly:
    askpass("Password for 'https://x-access-token@github.com': ") === "t0k" &&
    askpass("Password for 'https://x-access-token@gitlab.com': ") === "<refused>",
  worktreeRemovedAfterMerge: !worktreeLeft,
  agentServerEnvHasNoHandsToken: agentServerEnvClean,
};
log("events", JSON.stringify(session.events?.map((e) => `${e.type}: ${e.message}`), null, 2));
log("checks", JSON.stringify(checks, null, 2));
const ok = Object.values(checks).every(Boolean);
if (!ok) {
  try {
    log("container log tail:\n" + docker("logs", "--tail", "60", NAME));
  } catch {}
}
log(ok ? "DOCKER E2E PASS" : "DOCKER E2E FAIL");
cleanup();
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(ok ? 0 : 1);
