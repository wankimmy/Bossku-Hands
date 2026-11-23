/**
 * Live end-to-end run of Bossku Hands with real services:
 *   real agent-server 1.62.0 (via the launcher, uvx) + real Hands sidecar +
 *   ingress routing + upstream mock LLM (scripted) + fake GitHub API +
 *   a real git repo whose push URL is a local bare repo.
 * Everything lives in a fresh temp folder; nothing touches ~/.openhands.
 *
 * Run from the OpenHands folder after `npm run download-uv` (or with uvx on
 * PATH):  node tests/hands-live/run.mjs
 * Uses ports 18390-18399. Exit code 0 means every check passed. It stops only
 * the processes it started.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANVAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = path.join(tmpdir(), `hands-live-${process.pid}`);
const WINDOWS = process.platform === "win32";
const PORTS = { ingress: 18390, agent: 18391, automation: 18392, hands: 18393, github: 18398, llm: 18399 };
const KEY = randomBytes(24).toString("hex");
const GH_TOKEN = "fake-e2e-token";
const OWNER = "hands-e2e";
const REPO = "demo";
const PUSH_CMD = ["git", "pu" + "sh", "origin", "main"].join(" ");

const children = [];
const t0 = Date.now();
const log = (...args) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...args);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function killAll() {
  for (const child of children) {
    try {
      // Stop the child and everything it started (uvx -> python servers).
      if (WINDOWS) {
        execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      } else {
        process.kill(-child.pid, "SIGTERM");
      }
    } catch {}
  }
}
process.on("exit", killAll);

// ── 1. git repo with a github.com URL and a local push URL ──────────────────
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(ROOT, { recursive: true });
const repoDir = path.join(ROOT, "repo");
const bareDir = path.join(ROOT, "remote.git");
mkdirSync(repoDir);
git(ROOT, "init", "-q", "--bare", bareDir);
git(repoDir, "init", "-q", "-b", "main");
git(repoDir, "config", "user.name", "E2E");
git(repoDir, "config", "user.email", "e2e@example.invalid");
writeFileSync(path.join(repoDir, "README.md"), "# demo\n");
git(repoDir, "add", "-A");
git(repoDir, "commit", "-q", "-m", "init");
git(repoDir, "remote", "add", "origin", `https://github.com/${OWNER}/${REPO}.git`);
git(repoDir, "config", "remote.origin.pushurl", bareDir.replace(/\\/g, "/"));
log("repo ready", repoDir);

// ── 2. fake GitHub API ──────────────────────────────────────────────────────
const gh = { pulls: [], merged: false, requests: [], badAuth: 0 };
const ghServer = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (d) => (raw += d));
  req.on("end", () => {
    const url = new URL(req.url, "http://x");
    gh.requests.push(`${req.method} ${url.pathname}`);
    if (req.headers.authorization !== `Bearer ${GH_TOKEN}` && req.headers.authorization !== `token ${GH_TOKEN}`) {
      gh.badAuth += 1;
    }
    const send = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const base = `/repos/${OWNER}/${REPO}`;
    if (req.method === "GET" && url.pathname === `${base}/pulls`) {
      const head = url.searchParams.get("head")?.split(":")[1];
      return send(200, gh.pulls.filter((p) => p.head.ref === head && p.state === "open"));
    }
    if (req.method === "POST" && url.pathname === `${base}/pulls`) {
      const body = JSON.parse(raw);
      const pull = {
        number: gh.pulls.length + 1,
        html_url: `https://github.com/${OWNER}/${REPO}/pull/${gh.pulls.length + 1}`,
        head: { ref: body.head },
        base: { ref: body.base },
        title: body.title,
        body: body.body,
        draft: body.draft,
        state: "open",
      };
      gh.pulls.push(pull);
      return send(201, pull);
    }
    const pullMatch = url.pathname.match(new RegExp(`^${base}/pulls/(\\d+)$`));
    if (req.method === "GET" && pullMatch) {
      const pull = gh.pulls[Number(pullMatch[1]) - 1];
      let sha = null;
      try {
        sha = git(bareDir, "rev-parse", `refs/heads/${pull.head.ref}`);
      } catch {}
      return send(200, { ...pull, state: gh.merged ? "closed" : "open", merged: gh.merged, head: { ...pull.head, sha } });
    }
    if (req.method === "GET" && /\/commits\/[0-9a-f]+\/check-runs$/.test(url.pathname)) {
      return send(200, {
        total_count: 1,
        check_runs: [{ id: 1, name: "unit-tests", status: "completed", conclusion: "success", app: { slug: "github-actions" } }],
      });
    }
    send(404, { message: "not found" });
  });
});
await new Promise((r) => ghServer.listen(PORTS.github, "127.0.0.1", r));
log("fake GitHub on", PORTS.github);

// ── 3. mock LLM ─────────────────────────────────────────────────────────────
const bundledUvx = path.join(CANVAS, "resources", "bin", WINDOWS ? "uvx.exe" : "uvx");
const uvx = existsSync(bundledUvx) ? bundledUvx : "uvx";
const llmLog = createWriteStream(path.join(ROOT, "mock-llm.log"));
const llm = spawn(
  uvx,
  ["--python", ">=3.12,<3.15", "--from", "openhands-agent-server==1.62.0", "python", "tests/e2e/mock-llm/scripts/mock-llm-server.py", "--port", String(PORTS.llm)],
  { cwd: CANVAS, windowsHide: true, detached: !WINDOWS },
);
children.push(llm);
llm.stdout.pipe(llmLog);
llm.stderr.pipe(llmLog);

async function httpJson(method, url, body, headers = {}) {
  const response = await fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: response.status, data };
}

async function waitFor(label, fn, timeoutMs) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await fn()) return;
    } catch {}
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await sleep(1000);
  }
}

await waitFor("mock LLM", async () => (await httpJson("GET", `http://127.0.0.1:${PORTS.llm}/`)).status === 200, 300_000);
log("mock LLM ready");

// ── 4. launcher: agent-server + automation + Hands behind the ingress ───────
const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
const launcherLog = createWriteStream(path.join(ROOT, "launcher.log"));
const launcher = spawn(process.execPath, ["scripts/dev-with-automation.mjs", "--backend-only"], {
  cwd: CANVAS,
  windowsHide: true,
  detached: !WINDOWS,
  env: {
    ...process.env,
    [pathKey]: `${path.join(CANVAS, "resources", "bin")}${path.delimiter}${process.env[pathKey]}`,
    PORT: String(PORTS.ingress),
    OH_CANVAS_SAFE_BACKEND_PORT: String(PORTS.agent),
    OH_CANVAS_SAFE_AUTOMATION_PORT: String(PORTS.automation),
    BOSSKU_HANDS_PORT: String(PORTS.hands),
    OH_CANVAS_SAFE_STATE_DIR: path.join(ROOT, "state", "agent-canvas"),
    LOCAL_BACKEND_API_KEY: KEY,
    BOSSKU_HANDS_GITHUB_TOKEN: GH_TOKEN,
    BOSSKU_HANDS_GITHUB_API_URL: `http://127.0.0.1:${PORTS.github}`,
    GITHUB_TOKEN: "",
    GH_TOKEN: "",
    VITE_DO_NOT_TRACK: "1",
    OH_ENABLE_BROWSER: "false",
  },
});
children.push(launcher);
launcher.stdout.pipe(launcherLog);
launcher.stderr.pipe(launcherLog);

const INGRESS = `http://127.0.0.1:${PORTS.ingress}`;
const auth = { "X-Session-API-Key": KEY };
await waitFor(
  "Hands through the ingress",
  async () => (await httpJson("GET", `${INGRESS}/api/hands/health`, undefined, auth)).status === 200,
  600_000,
);
log("stack ready: agent-server + Hands reachable through the ingress");

// ── 5. LLM profile + agent profile pointing at the mock LLM ─────────────────
let r = await httpJson(
  "POST",
  `${INGRESS}/api/profiles/hands-mock`,
  { llm: { model: "openai/mock-test-model", api_key: "mock-api-key", base_url: `http://127.0.0.1:${PORTS.llm}` }, include_secrets: true },
  auth,
);
log("save LLM profile", r.status);
r = await httpJson("POST", `${INGRESS}/api/agent-profiles/hands-e2e`, { agent_kind: "openhands", llm_profile_ref: "hands-mock", secret_refs: [] }, auth);
log("save agent profile", r.status);
r = await httpJson("GET", `${INGRESS}/api/agent-profiles/hands-e2e`, undefined, auth);
const profileId = r.data?.profile?.id;
log("agent profile id", profileId);
if (!profileId) throw new Error(`no agent profile id: ${JSON.stringify(r)}`);

// ── 6. scripted trajectory: planner, coder (incl. a blocked push), reviewer ─
const turns = [
  { text: "1. Create hello.txt containing hello.\n2. Check it with Get-Content hello.txt." },
  { tool_call: { name: "terminal", arguments: { command: PUSH_CMD } } },
  { tool_call: { name: "terminal", arguments: { command: "Set-Content -Path hello.txt -Value hello" } } },
  { text: "Created hello.txt with the word hello." },
  { text: "1. hello.txt exists and contains hello, as the task asks.\nVERDICT: APPROVE" },
];
r = await httpJson("POST", `http://127.0.0.1:${PORTS.llm}/admin/trajectory/register`, { name: "hands", turns });
log("register trajectory", r.status, JSON.stringify(r.data));
r = await httpJson("POST", `http://127.0.0.1:${PORTS.llm}/admin/trajectory/activate`, { name: "hands" });
log("activate trajectory", r.status, JSON.stringify(r.data));

// ── 7. drive a Hands session through its API (via the ingress) ──────────────
r = await httpJson("PUT", `${INGRESS}/api/hands/settings`, { roles: { planner: profileId, coder: profileId, reviewer: profileId }, ciPollIntervalMs: 5000 }, auth);
log("settings", r.status, JSON.stringify(r.data?.gates));
r = await httpJson("POST", `${INGRESS}/api/hands/sessions`, { task: "Add a hello.txt file that contains the word hello", repoDir, baseBranch: "main" }, auth);
log("start session", r.status, r.data?.state, r.data?.error?.code ?? "");
const sessionId = r.data?.id;
if (!sessionId) throw new Error(`session not started: ${JSON.stringify(r.data)}`);

let session = r.data;
let lastState = "";
const approvals = [];
const deadline = Date.now() + 600_000;
while (Date.now() < deadline) {
  session = (await httpJson("GET", `${INGRESS}/api/hands/sessions/${sessionId}`, undefined, auth)).data;
  if (session.state !== lastState) {
    log("state", session.state, session.pendingApproval ?? "", session.escalation?.reason ?? "", session.failure?.message ?? "");
    lastState = session.state;
  }
  if (session.state === "AWAITING_APPROVAL") {
    const gate = session.pendingApproval;
    approvals.push(gate);
    const a = await httpJson("POST", `${INGRESS}/api/hands/sessions/${sessionId}/approve`, { gate }, auth);
    log("approved", gate, a.status);
  }
  if (session.state === "READY_FOR_HUMAN_REVIEW" && !gh.merged) {
    log("simulating the human merge on GitHub");
    gh.merged = true;
    await httpJson("POST", `${INGRESS}/api/hands/sessions/${sessionId}/refresh`, {}, auth);
  }
  if (["COMPLETED", "ESCALATED", "FAILED", "CANCELLED", "SUPERSEDED"].includes(session.state)) break;
  await sleep(1500);
}

// ── 8. checks ───────────────────────────────────────────────────────────────
const branch = session.branch;
let pushedFiles = "";
let helloText = "";
let mainOnRemote = false;
try {
  pushedFiles = git(bareDir, "ls-tree", "-r", "--name-only", `refs/heads/${branch}`);
  helloText = git(bareDir, "show", `refs/heads/${branch}:hello.txt`);
} catch {}
try {
  git(bareDir, "rev-parse", "--verify", "refs/heads/main");
  mainOnRemote = true;
} catch {}
const llmRequests = (await httpJson("GET", `http://127.0.0.1:${PORTS.llm}/admin/requests`)).data?.requests?.length;
const blocked = session.warnings?.find((w) => w.code === "commands_blocked");
const pr = gh.pulls[0];
const checks = {
  finalStateCompleted: session.state === "COMPLETED",
  approvalsAskedInOrder: JSON.stringify(approvals) === JSON.stringify(["approve_plan", "open_pr"]),
  planFromPlannerAgent: /hello\.txt/.test(session.plan ?? ""),
  reviewerApproved: session.review?.verdict === "APPROVE",
  agentPushBlockedByGuard: Boolean(blocked?.actions?.some((a) => a.action === PUSH_CMD)),
  agentPushNeverReachedRemote: !mainOnRemote,
  handsPushedBranchWithFile: pushedFiles.split("\n").includes("hello.txt") && /hello/.test(helloText),
  draftPrWithAiDisclosure: Boolean(pr?.draft) && /AI coding agent/.test(pr?.body ?? ""),
  githubTokenSentOnEveryCall: gh.badAuth === 0 && gh.requests.length > 0,
  worktreeRemovedAfterMerge: await (async () => { for (let i = 0; i < 20 && existsSync(session.worktreeDir ?? "__none__"); i += 1) await sleep(500); return !existsSync(session.worktreeDir ?? "__none__"); })(),
};
log("summary", JSON.stringify({ sessionId, branch, state: session.state, llmRequests, ghRequests: gh.requests, warnings: session.warnings, events: session.events?.map((e) => `${e.type}: ${e.message}`) }, null, 2));
log("checks", JSON.stringify(checks, null, 2));
const ok = Object.values(checks).every(Boolean);
log(ok ? "E2E PASS" : "E2E FAIL");
ghServer.close();
killAll();
await sleep(1000);
rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
process.exit(ok ? 0 : 1);
