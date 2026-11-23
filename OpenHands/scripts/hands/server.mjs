/**
 * The local Bossku Hands service: a small JSON API over the orchestrator,
 * started by the dev/desktop launcher beside the agent-server and reached
 * through the ingress at `/api/hands`.
 *
 * It lives exactly as long as the app. It binds to 127.0.0.1 only, demands
 * the launcher's session key on every request, refuses Host headers that are
 * not loopback (DNS rebinding), and exits on its own when its parent process
 * is gone, so no hidden listener survives the app.
 */

import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createAgentServerRunner } from "./agent-runner.mjs";
import { createGit, writeAskpassScript } from "./git.mjs";
import { createGithubClient } from "./github.mjs";
import { createEdgeBrowserSetup } from "./edge-browser.mjs";
import { createLinearClient } from "./linear.mjs";
import { createOrchestrator } from "./orchestrator.mjs";

export const DEFAULT_HANDS_PORT = 18002;
const MAX_BODY_BYTES = 64 * 1024;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const STATUS_BY_CODE = {
  invalid_json: 400,
  invalid_task: 400,
  invalid_base_branch: 400,
  invalid_settings: 400,
  not_a_git_repository: 400,
  unauthorized: 401,
  forbidden_host: 403,
  session_not_found: 404,
  not_found: 404,
  approval_gate_mismatch: 409,
  not_awaiting_approval: 409,
  not_suspended: 409,
  not_failed: 409,
  session_finished: 409,
  body_too_large: 413,
  orchestrator_stopped: 503,
  invalid_linear_issue: 400,
  invalid_linear_team: 400,
  linear_not_configured: 400,
  linear_key_missing: 400,
  linear_key_invalid: 400,
  linear_issue_not_found: 404,
  linear_team_not_mapped: 409,
  linear_issue_in_progress: 409,
  linear_sync_not_ready: 409,
  linear_rate_limited: 429,
  linear_request_failed: 502,
  agent_server_request_failed: 502,
  not_supported: 501,
};

const apiError = (code, extra = {}) =>
  Object.assign(new Error(code), { code, ...extra });

function send(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...headers,
  });
  res.end(text);
}

function sendError(res, error) {
  const code = typeof error?.code === "string" ? error.code : "internal_error";
  const status = STATUS_BY_CODE[code] ?? 500;
  const body = { error: { code } };
  if (status !== 500) {
    if (error.message && error.message !== code)
      body.error.message = error.message;
    if (error.field) body.error.field = error.field;
    if (error.teamKey) body.error.teamKey = error.teamKey;
    if (error.sessionId) body.error.sessionId = error.sessionId;
  }
  send(res, status, body, status === 413 ? { connection: "close" } : {});
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        reject(apiError("body_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        const value = JSON.parse(text);
        resolve(value && typeof value === "object" ? value : {});
      } catch {
        reject(apiError("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function hostIsLoopback(hostHeader) {
  const host = String(hostHeader ?? "").toLowerCase();
  const name = host.startsWith("[")
    ? host.slice(0, host.indexOf("]") + 1)
    : host.split(":")[0];
  return LOOPBACK_HOSTS.has(name);
}

function keyMatches(given, expected) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Sends an orchestrator result, turning an `{ error }` refusal into its status. */
function sendResult(res, result, okStatus = 200) {
  if (result?.error) {
    const { error, ...session } = result;
    send(res, STATUS_BY_CODE[error.code] ?? 409, {
      error,
      ...(session.id ? { session } : {}),
    });
    return;
  }
  send(res, okStatus, result);
}

/**
 * @param {{
 *   orchestrator: ReturnType<typeof createOrchestrator>,
 *   sessionApiKey: string,
 *   browser?: ReturnType<typeof import("./edge-browser.mjs").createEdgeBrowserSetup> | null,
 * }} options
 */
export function createHandsServer({
  orchestrator,
  sessionApiKey,
  browser = null,
}) {
  if (!sessionApiKey)
    throw new TypeError("createHandsServer needs a session key");

  return createServer(async (req, res) => {
    try {
      if (!hostIsLoopback(req.headers.host)) throw apiError("forbidden_host");
      if (!keyMatches(req.headers["x-session-api-key"], sessionApiKey)) {
        throw apiError("unauthorized");
      }
      const { pathname } = new URL(req.url ?? "/", "http://localhost");
      const parts = pathname.replace(/\/+$/, "").split("/").slice(1);
      if (parts[0] !== "api" || parts[1] !== "hands")
        throw apiError("not_found");
      const [resource, id, action, extra] = parts.slice(2);
      const method = req.method ?? "GET";

      if (resource === "health" && method === "GET") {
        send(res, 200, { ok: true });
        return;
      }
      if (resource === "browser") {
        if (!browser) throw apiError("not_supported");
        if (!id && method === "GET") {
          send(res, 200, await browser.status());
          return;
        }
        if (id === "edge" && !action && method === "POST") {
          send(res, 200, await browser.install());
          return;
        }
      }
      if (resource === "connections" && !id && method === "GET") {
        send(res, 200, await orchestrator.connections());
        return;
      }
      if (resource === "linear") {
        if (id === "issues" && !action && method === "GET") {
          send(res, 200, await orchestrator.linearInbox());
          return;
        }
        if (
          id === "issues" &&
          action &&
          extra === "start" &&
          method === "POST"
        ) {
          const body = await readJson(req);
          const session = await orchestrator.startFromLinear(action, {
            repoDir: body.repoDir,
            baseBranch: body.baseBranch,
          });
          send(res, 201, session);
          return;
        }
        if (
          id === "teams" &&
          action &&
          extra === "states" &&
          method === "GET"
        ) {
          send(res, 200, await orchestrator.linearTeamStates(action));
          return;
        }
      }
      if (resource === "settings" && !id) {
        if (method === "GET") {
          send(res, 200, orchestrator.getSettings());
          return;
        }
        if (method === "PUT") {
          send(res, 200, orchestrator.updateSettings(await readJson(req)));
          return;
        }
      }
      if (resource === "sessions") {
        if (!id && method === "GET") {
          send(res, 200, { sessions: orchestrator.listSessions() });
          return;
        }
        if (!id && method === "POST") {
          const body = await readJson(req);
          const session = await orchestrator.startSession({
            source: "chat",
            task: body.task,
            repoDir: body.repoDir,
            baseBranch: body.baseBranch || undefined,
          });
          send(res, 201, session);
          return;
        }
        if (id && !action && method === "GET") {
          const session = orchestrator.getSession(id);
          if (!session) throw apiError("session_not_found");
          send(res, 200, session);
          return;
        }
        if (id && action === "diff" && method === "GET") {
          send(res, 200, await orchestrator.sessionDiff(id));
          return;
        }
        if (id && method === "POST") {
          if (action === "approve") {
            const body = await readJson(req);
            sendResult(res, await orchestrator.approve(id, body.gate));
            return;
          }
          if (["cancel", "resume", "retry", "refresh"].includes(action)) {
            sendResult(res, await orchestrator[action](id));
            return;
          }
          if (action === "linear-sync") {
            sendResult(res, await orchestrator.syncLinear(id));
            return;
          }
        }
      }
      throw apiError("not_found");
    } catch (error) {
      if (!STATUS_BY_CODE[error?.code]) {
        console.error("[hands] request failed:", error?.message ?? error);
      }
      sendError(res, error);
    }
  });
}

/** Entry point used by the launcher: `node scripts/hands/server.mjs`. */
/**
 * The GitHub API base. BOSSKU_HANDS_GITHUB_API_URL overrides it (used by the
 * local end-to-end test); the token is sent there, so only https, or plain
 * http on loopback, is accepted.
 */
export function resolveGithubApiBase(value) {
  if (!value) return "https://api.github.com";
  const invalid = () =>
    new Error(
      "BOSSKU_HANDS_GITHUB_API_URL must be an https URL, or http on 127.0.0.1",
    );
  let url;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  const secure =
    url.protocol === "https:" ||
    (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname));
  if (!secure || url.username || url.password) throw invalid();
  return url.toString().replace(/\/+$/, "");
}

export async function main(env = process.env) {
  const sessionApiKey = env.SESSION_API_KEY;
  if (!sessionApiKey) {
    console.error("[hands] SESSION_API_KEY is not set; not starting");
    process.exitCode = 1;
    return;
  }
  const port = Number.parseInt(env.BOSSKU_HANDS_PORT, 10) || DEFAULT_HANDS_PORT;
  const dataDir =
    env.BOSSKU_HANDS_DATA_DIR ||
    path.join(homedir(), ".openhands", "agent-canvas", "hands");
  let apiBase;
  try {
    apiBase = resolveGithubApiBase(env.BOSSKU_HANDS_GITHUB_API_URL);
  } catch (error) {
    console.error(`[hands] ${error.message}; not starting`);
    process.exitCode = 1;
    return;
  }

  const githubToken = () =>
    env.BOSSKU_HANDS_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || null;
  // Outside Windows (Docker) there is usually no git credential manager, so
  // Hands' own pushes answer git's https prompt with the GitHub token.
  // A credential helper, when configured, still takes precedence.
  const askpass =
    process.platform === "win32" ? null : writeAskpassScript(dataDir);
  const git = createGit({
    pushEnv: () => {
      const token = githubToken();
      return askpass && token
        ? {
            GIT_ASKPASS: askpass,
            GIT_TERMINAL_PROMPT: "0",
            BOSSKU_HANDS_ASKPASS_TOKEN: token,
          }
        : null;
    },
  });

  const orchestrator = createOrchestrator({
    git,
    agent: createAgentServerRunner({
      host: env.AGENT_SERVER_URL || "http://127.0.0.1:18000",
      apiKey: sessionApiKey,
    }),
    github: createGithubClient({ apiBase, getToken: githubToken }),
    linear: createLinearClient({
      getApiKey: () =>
        env.BOSSKU_HANDS_LINEAR_API_KEY || env.LINEAR_API_KEY || null,
    }),
    dataDir,
    onEvent: (event) => {
      if (event.type === "state") {
        console.log(`[hands] ${event.sessionId} ${event.session.state}`);
      }
    },
  });
  const server = createHandsServer({
    orchestrator,
    sessionApiKey,
    browser: createEdgeBrowserSetup({
      agentServerUrl: env.AGENT_SERVER_URL || "http://127.0.0.1:18000",
      apiKey: sessionApiKey,
    }),
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await orchestrator.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  // Never outlive the app: exit when the launcher that started us is gone.
  const parentPid = process.ppid;
  setInterval(() => {
    try {
      process.kill(parentPid, 0);
    } catch {
      shutdown();
    }
  }, 5000).unref();

  server.listen(port, "127.0.0.1", () => {
    console.log(`[hands] listening on 127.0.0.1:${port}, data in ${dataDir}`);
    orchestrator.resumeWaiting();
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
