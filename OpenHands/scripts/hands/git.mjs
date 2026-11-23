/**
 * The few git operations Bossku Hands needs, run through `execFile` with an
 * argument array so no value is ever parsed by a shell.
 *
 * Hands only ever writes to its own branches (`hands/<session id>`) inside its
 * own worktree. It never force-pushes and never pushes the base branch, so a
 * mistake in an agent stage cannot rewrite anyone else's history.
 */

import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const HANDS_BRANCH_PATTERN = /^hands\/[a-z0-9][a-z0-9-]{0,63}$/;

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Bossku Hands",
  "-c",
  "user.email=hands@bossku.local",
];

/** Throws unless `branch` is a branch Hands owns. */
export function assertHandsBranch(branch) {
  if (typeof branch !== "string" || !HANDS_BRANCH_PATTERN.test(branch)) {
    throw Object.assign(new Error(`not a Hands branch: ${branch}`), {
      code: "not_app_owned_branch",
    });
  }
}

/**
 * @param {{
 *   run?: (args: string[], options: { cwd?: string, signal?: AbortSignal, env?: Record<string, string> }) => Promise<string>,
 *   pushEnv?: () => Record<string, string> | null,
 * }} [deps]
 */
export function createGit(deps = {}) {
  const run =
    deps.run ??
    ((args, { cwd, signal, env } = {}) =>
      new Promise((resolve, reject) => {
        execFile(
          "git",
          args,
          {
            cwd,
            signal,
            env: env ? { ...process.env, ...env } : undefined,
            windowsHide: true,
            maxBuffer: 16 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            if (error) {
              reject(
                Object.assign(error, { stderr: String(stderr ?? "").trim() }),
              );
              return;
            }
            resolve(String(stdout));
          },
        );
      }));

  const git = (cwd, args, signal) => run(args, { cwd, signal });

  return {
    /** The repository's top-level directory, or a rejection when it is not one. */
    async topLevel(dir) {
      return (await git(dir, ["rev-parse", "--show-toplevel"])).trim();
    },

    async currentBranch(dir) {
      return (await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    },

    async headSha(dir) {
      return (await git(dir, ["rev-parse", "HEAD"])).trim();
    },

    async remoteUrl(dir, remote = "origin") {
      return (await git(dir, ["remote", "get-url", remote])).trim();
    },

    /**
     * Creates `branch` from `base` in a worktree at `worktreeDir`, or reuses
     * what an interrupted run already created, then blocks git network use
     * from inside it (see blockAgentGitNetwork).
     */
    async addWorktree(repoDir, worktreeDir, branch, base) {
      assertHandsBranch(branch);
      if (!existsSync(path.join(worktreeDir, ".git"))) {
        mkdirSync(path.dirname(worktreeDir), { recursive: true });
        const branchExists = await git(repoDir, [
          "rev-parse",
          "--verify",
          "--quiet",
          `refs/heads/${branch}`,
        ]).then(
          () => true,
          () => false,
        );
        await git(
          repoDir,
          branchExists
            ? ["worktree", "add", worktreeDir, branch]
            : ["worktree", "add", "-b", branch, worktreeDir, base],
        );
      }
      await blockAgentGitNetwork(repoDir, worktreeDir);
    },

    /**
     * Removes the worktree. When git cannot delete the folder (on Windows a
     * process may still hold it), the folder is deleted with retries and the
     * worktree list is pruned.
     */
    async removeWorktree(repoDir, worktreeDir) {
      try {
        await git(repoDir, ["worktree", "remove", "--force", worktreeDir]);
      } catch (error) {
        if (!existsSync(worktreeDir)) throw error;
      }
      if (existsSync(worktreeDir)) {
        rmSync(worktreeDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200,
        });
      }
      await git(repoDir, ["worktree", "prune"]);
    },

    /** Paths with uncommitted changes, tracked or not. */
    async changedFiles(dir) {
      const out = await git(dir, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ]);
      return out
        .split("\0")
        .filter(Boolean)
        .map((entry) => entry.slice(3));
    },

    /**
     * Commits every change except secret-looking files, which stay
     * untracked. Resolves to `{ sha, skipped }`; `sha` is null when there
     * was nothing to commit.
     */
    async commitAll(dir, message, signal) {
      await git(dir, ["add", "--all"], signal);
      const staged = (
        await git(dir, ["diff", "--cached", "--name-only", "-z"], signal)
      )
        .split("\0")
        .filter(Boolean);
      const skipped = staged.filter(isSecretFile);
      if (skipped.length > 0) {
        await git(dir, ["reset", "-q", "--", ...skipped], signal);
      }
      if (staged.length === skipped.length) return { sha: null, skipped };
      await git(
        dir,
        [...COMMIT_IDENTITY, "commit", "-q", "-m", message],
        signal,
      );
      const sha = (await git(dir, ["rev-parse", "HEAD"], signal)).trim();
      return { sha, skipped };
    },

    /**
     * Files changed on `branch` since it left `base`, with line counts.
     * External diff drivers and textconv filters are never run.
     */
    async diffFiles(repoDir, base, branch) {
      assertHandsBranch(branch);
      const out = await git(repoDir, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--numstat",
        "-z",
        `${base}...${branch}`,
        "--",
      ]);
      return out
        .split("\0")
        .filter(Boolean)
        .map((record) => {
          const [added, deleted, ...rest] = record.split("\t");
          return {
            path: rest.join("\t"),
            additions: added === "-" ? null : Number(added),
            deletions: deleted === "-" ? null : Number(deleted),
          };
        });
    },

    /** The unified diff of `branch` against `base`, cut at `maxChars`. */
    async diffPatch(repoDir, base, branch, maxChars = 400_000) {
      assertHandsBranch(branch);
      const out = await git(repoDir, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--no-color",
        `${base}...${branch}`,
        "--",
      ]);
      return out.length > maxChars
        ? { patch: out.slice(0, maxChars), truncated: true }
        : { patch: out, truncated: false };
    },

    /** Drops every change since `sha` (default HEAD), including new files. */
    async discardChanges(dir, sha = "HEAD") {
      await git(dir, ["reset", "-q", "--hard", sha]);
      await git(dir, ["clean", "-q", "-fd"]);
    },

    /**
     * Pushes a Hands branch to origin without force. The push runs from the
     * user's own checkout (`repoDir`), because the worktree's git network
     * access is blocked for the agents.
     */
    async pushBranch(dir, branch, signal, repoDir = dir) {
      assertHandsBranch(branch);
      const current = (
        await git(dir, ["rev-parse", "--abbrev-ref", "HEAD"], signal)
      ).trim();
      if (current !== branch) {
        throw Object.assign(
          new Error(`worktree is on ${current}, expected ${branch}`),
          { code: "not_app_owned_branch" },
        );
      }
      // Extra environment (container push credentials) goes to this one
      // command only, never to agents or other git calls.
      const env = deps.pushEnv?.() ?? undefined;
      await run(
        ["push", "-q", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
        { cwd: repoDir, signal, ...(env ? { env } : {}) },
      );
    },
  };

  /**
   * Agents run shell commands in the worktree with the user's git
   * credentials. To stop an agent pushing (or force-pushing) on its own,
   * the worktree's own config rewrites every remote URL to a scheme git
   * cannot reach. `insteadOf` also applies to explicit push URLs and to URLs
   * typed on the command line. It needs `extensions.worktreeConfig`, which
   * keeps the rewrite out of the user's main checkout, where Hands pushes.
   */
  async function blockAgentGitNetwork(repoDir, worktreeDir) {
    await git(repoDir, ["config", "extensions.worktreeConfig", "true"]);
    const key = `url.${AGENT_BLOCKED_URL}.insteadOf`;
    await git(worktreeDir, ["config", "--worktree", "--unset-all", key]).catch(
      () => {},
    );
    const remoteUrls = await git(repoDir, [
      "config",
      "--get-regexp",
      "^remote\\..*\\.(push)?url$",
    ]).then(
      (out) =>
        out
          .split(/\r?\n/)
          .map((line) => line.slice(line.indexOf(" ") + 1).trim())
          .filter(Boolean),
      () => [],
    );
    // Local-path remotes need their own entry; URL remotes are covered above.
    const localRemotes = remoteUrls.filter(
      (url) => !BLOCKED_URL_PREFIXES.some((prefix) => url.startsWith(prefix)),
    );
    // Second layer: no transport at all from inside the worktree (https, ssh,
    // git, local paths), whatever URL is typed.
    await git(worktreeDir, ["config", "--worktree", "protocol.allow", "never"]);
    for (const prefix of new Set([...BLOCKED_URL_PREFIXES, ...localRemotes])) {
      await git(worktreeDir, ["config", "--worktree", "--add", key, prefix]);
    }
  }
}

/**
 * Writes the askpass helper Hands uses to push over https where no git
 * credential manager exists (Docker). It reads the token from the push
 * command's own environment, so the token is never written to disk.
 */
export function writeAskpassScript(dir) {
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "git-askpass.sh");
  writeFileSync(
    file,
    [
      "#!/bin/sh",
      "# Answers git's https prompts for github.com only. Any other host, or",
      "# any other prompt, gets nothing, so the token cannot reach another server.",
      'case "$1" in',
      `  "Username for 'https://github.com'"*) echo x-access-token ;;`,
      `  "Password for 'https://x-access-token@github.com'"*) printf '%s\\n' "$BOSSKU_HANDS_ASKPASS_TOKEN" ;;`,
      "  *) exit 1 ;;",
      "esac",
      "",
    ].join("\n"),
    { mode: 0o700 },
  );
  chmodSync(file, 0o700);
  return file;
}

const AGENT_BLOCKED_URL = "hands-agent-git-blocked://";
const BLOCKED_URL_PREFIXES = [
  "https://",
  "http://",
  "ssh://",
  "git://",
  "git@",
  "file://",
];

const SECRET_FILE_PATTERN =
  /(^|\/)(\.env(\.[^/]*)?|[^/]+\.env|\.envrc|\.dev\.vars|\.npmrc|\.netrc|\.pypirc|id_(rsa|dsa|ecdsa|ed25519)|credentials(\.json)?|secrets?\.(json|ya?ml|toml|env|ini)|[^/]*service[-_]?account[^/]*\.json|[^/]+\.(pem|key|p12|pfx|jks|keystore|tfvars))$/i;
const SECRET_TEMPLATE_PATTERN = /\.env\.(example|sample|template)$/i;

/** True for files that usually hold credentials and must never be committed. */
export function isSecretFile(file) {
  const normalised = String(file).replace(/\\/g, "/");
  return (
    SECRET_FILE_PATTERN.test(normalised) &&
    !SECRET_TEMPLATE_PATTERN.test(normalised)
  );
}
