/**
 * The GitHub REST calls the Hands CI observer makes: find or open a draft PR,
 * and read a PR's state, head commit and check runs.
 *
 * Polling only — no webhook, no public callback URL — so it works from a
 * desktop that is closed half the time. The token is read per request from
 * `getToken`, never stored here and never written to an error message.
 */

const API_VERSION = "2022-11-28";
const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);
const MAX_FAILED_RUNS_WITH_LOGS = 5;
const REQUEST_TIMEOUT_MS = 20_000;

const githubError = (code, message, extra = {}) =>
  Object.assign(new Error(message ?? code), { code, ...extra });

const REMOTE_PATTERN =
  /^(?:https:\/\/(?:[^@/\s]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;

/** `{ owner, repo }` for a github.com remote URL; throws `unsupported_remote` otherwise. */
export function parseGithubRemote(remoteUrl) {
  const match = REMOTE_PATTERN.exec(String(remoteUrl ?? "").trim());
  if (!match) {
    throw githubError(
      "unsupported_remote",
      "Hands can only open pull requests on github.com remotes",
    );
  }
  return { owner: match[1], repo: match[2] };
}

/**
 * @param {{
 *   getToken: () => string | null | undefined | Promise<string | null | undefined>,
 *   fetchImpl?: typeof fetch,
 *   apiBase?: string,
 *   logTailChars?: number,
 * }} options
 */
/** A PR link, only when it is an https://github.com address. */
function githubUrl(value) {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "github.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function createGithubClient({
  getToken,
  fetchImpl = globalThis.fetch,
  apiBase = "https://api.github.com",
  logTailChars = 4000,
}) {
  async function request(method, path, body) {
    const token = await getToken();
    if (!token) {
      throw githubError(
        "github_token_missing",
        "Set BOSSKU_HANDS_GITHUB_TOKEN (or GITHUB_TOKEN) so Hands can open pull requests",
      );
    }
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      redirect: "follow",
      // A hung request must not stall the CI observer or app shutdown.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "bossku-hands",
        "x-github-api-version": API_VERSION,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (
      (response.status === 403 || response.status === 429) &&
      response.headers.get("x-ratelimit-remaining") === "0"
    ) {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      throw githubError(
        "github_rate_limited",
        "GitHub API rate limit reached",
        {
          retryAt: Number.isFinite(reset)
            ? new Date(reset * 1000).toISOString()
            : null,
        },
      );
    }
    if (response.status === 401) {
      throw githubError("github_token_invalid", "GitHub rejected the token");
    }
    if (!response.ok) {
      throw githubError(
        "github_request_failed",
        `GitHub ${method} ${path.split("?")[0]} returned ${response.status}`,
        { status: response.status },
      );
    }
    return response;
  }

  const json = async (method, path, body) =>
    (await request(method, path, body)).json();

  async function jobLogTail(owner, repo, run) {
    if (run.app?.slug !== "github-actions") return "";
    try {
      const response = await request(
        "GET",
        `/repos/${owner}/${repo}/actions/jobs/${run.id}/logs`,
      );
      return (await response.text()).slice(-logTailChars);
    } catch {
      return "";
    }
  }

  async function summariseChecks(owner, repo, runs) {
    if (runs.length === 0) return { status: "none" };
    if (runs.some((run) => run.status !== "completed")) {
      return { status: "pending" };
    }
    const failed = runs.filter((run) => FAILED_CONCLUSIONS.has(run.conclusion));
    if (failed.length === 0) return { status: "success" };
    const failures = await Promise.all(
      failed.slice(0, MAX_FAILED_RUNS_WITH_LOGS).map(async (run) => ({
        name: run.name,
        conclusion: run.conclusion,
        summary: [
          run.output?.title,
          run.output?.summary,
          await jobLogTail(owner, repo, run),
        ]
          .filter(Boolean)
          .join("\n"),
      })),
    );
    return { status: "failure", failures };
  }

  return {
    /** The account the token belongs to (login only). */
    async viewer() {
      const user = await json("GET", "/user");
      return { login: user.login };
    },

    async findPull({ remoteUrl, head }) {
      const { owner, repo } = parseGithubRemote(remoteUrl);
      const query = new URLSearchParams({
        state: "open",
        head: `${owner}:${head}`,
      });
      const pulls = await json("GET", `/repos/${owner}/${repo}/pulls?${query}`);
      const pull = Array.isArray(pulls) ? pulls[0] : null;
      return pull
        ? { number: pull.number, url: githubUrl(pull.html_url) }
        : null;
    },

    async createPull({ remoteUrl, head, base, title, body, draft = true }) {
      const { owner, repo } = parseGithubRemote(remoteUrl);
      const pull = await json("POST", `/repos/${owner}/${repo}/pulls`, {
        title,
        head,
        base,
        body,
        draft,
      });
      return { number: pull.number, url: githubUrl(pull.html_url) };
    },

    async getPullStatus({ remoteUrl, number }) {
      const { owner, repo } = parseGithubRemote(remoteUrl);
      const pull = await json("GET", `/repos/${owner}/${repo}/pulls/${number}`);
      const status = {
        state: pull.state,
        merged: Boolean(pull.merged),
        headSha: pull.head?.sha ?? null,
        ci: { status: "pending" },
      };
      if (status.merged || status.state === "closed" || !status.headSha) {
        return status;
      }
      const checks = await json(
        "GET",
        `/repos/${owner}/${repo}/commits/${status.headSha}/check-runs?per_page=100`,
      );
      status.ci = await summariseChecks(owner, repo, checks.check_runs ?? []);
      return status;
    },
  };
}
