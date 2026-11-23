/**
 * Command guard for Hands agent stages.
 *
 * Hands starts every stage with the Agent Server's AlwaysConfirm policy, so
 * each batch of agent actions waits for Hands, and every action is checked
 * here before it runs. A refused action goes back to the agent with the
 * reason, so it can pick another way.
 *
 * Shell commands are split into simple commands (pipes, `&&`, `;`, `$(...)`,
 * backticks, comments, `bash -c`, `cmd /c`, `powershell -Command`,
 * `find -exec`, `xargs`, `npx -c`, `env -S`; here-document bodies are text).
 * Every simple command must be on the allow list (or be a script inside the
 * worktree), must pass its command's own rules, and every argument that names
 * a path must resolve inside the worktree, following symlinks. File tools
 * follow the same path rules; read-only stages cannot write.
 *
 * This is a filter, not a sandbox: code inside a script the agent writes and
 * then runs (`node x.js`, `python -c ...`) is not inspected.
 */

import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { parse } from "shell-quote";

const ALLOW = Object.freeze({ allow: true });
const deny = (reason) => ({ allow: false, reason });

const REASONS = {
  git: "Hands runs git commit, push, fetch, branch, checkout and config itself. Leave your changes in the working tree; use git status, diff, log, show, add or restore.",
  gitUnknown:
    "this git command is not on the Hands allow list (status, diff, log, show, add, restore, rm, mv, stash, grep, blame).",
  gh: "GitHub writes are done by Hands. Only read commands such as gh pr view, gh run view or gh api (GET) are allowed.",
  outside: (target) =>
    `"${target}" is outside the Hands worktree. Work only inside the current repository folder.`,
  symlink: (target) =>
    `"${target}" leads outside the Hands worktree through a link.`,
  gitDir: "files inside .git are managed by Hands and git.",
  worktreeRoot: "deleting the whole worktree is not allowed.",
  nestedShell:
    "Hands cannot check commands passed this way. Run the command directly.",
  stdinShell:
    "a shell or interpreter reading commands from standard input cannot be checked. Run a script file instead.",
  evalCode:
    "eval and Invoke-Expression run generated code that Hands cannot check.",
  dynamicName:
    "the command name must be written out, not built from variables or substitutions.",
  unknownCommand: (name) =>
    `"${name}" is not on the Hands command allow list. Use a common development tool, or a script inside the repository.`,
  sudo: "running commands as another user is not allowed.",
  secrets: "this reads credentials or secret environment variables.",
  envDump:
    "printing environment variables can leak secrets. Read only the setting you need from a project file.",
  envOverride:
    "overriding git, loader or shell start-up settings through the environment is not allowed.",
  globalInstall:
    "global or system-wide installs are not allowed. Install into the project (npm install, a .venv, or uv pip install).",
  upload: "sending files or data to another server is not allowed.",
  remote: "opening a connection to another machine is not allowed.",
  system: "this changes system settings, services or scheduled tasks.",
  dockerHost:
    "privileged containers, host networking and host folder mounts outside the worktree are not allowed.",
  link: "links that point outside the worktree are not allowed.",
  readOnly:
    "this stage is read-only. Describe the change you would make instead of editing files.",
  subAgent:
    "sub-agents run outside the Hands guard. Do the work in this conversation.",
  unknownTool: (kind) => `the ${kind} tool is not allowed in Hands stages.`,
  mcpTool: (name) =>
    `the MCP tool ${name} is not allowed; only browser tools are.`,
  browserTool: (name) =>
    `the browser tool ${name} can run page scripts, upload files or rewrite traffic, so it is not allowed.`,
  browserUrl: "the browser may open only http and https pages.",
  tooDeep: "commands nested this deeply cannot be checked.",
};

// ── Command sets ────────────────────────────────────────────────────────────

const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "ash"]);
const POWERSHELLS = new Set(["powershell", "pwsh"]);
const INTERPRETERS = new Set([
  ...SHELLS,
  ...POWERSHELLS,
  "cmd",
  "python",
  "python3",
  "py",
  "node",
  "perl",
  "ruby",
  "php",
  "deno",
  "bun",
  "tsx",
  "ts-node",
]);
/** Flags whose value is inline code (not inspected, not a path). */
const CODE_FLAGS = new Set([
  "-c",
  "-e",
  "-E",
  "-p",
  "-r",
  "--eval",
  "--print",
  "--command",
]);
/** Wrappers that run the command after them, with flags that take a value. */
const WRAPPERS = {
  nice: new Set(["-n", "--adjustment"]),
  time: new Set(["-f", "--format", "-o", "--output"]),
  command: new Set(),
  builtin: new Set(),
  nohup: new Set(),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  exec: new Set(["-a"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  npx: new Set(["-p", "--package"]),
  uvx: new Set(["--from", "--with", "-p", "--python", "--with-requirements"]),
};
const RUN_AS = new Set(["sudo", "su", "doas", "runas", "pkexec", "gsudo"]);
const EVAL = new Set(["eval", "iex", "invoke-expression"]);
const REMOVE = new Set([
  "rm",
  "rmdir",
  "rd",
  "del",
  "erase",
  "remove-item",
  "ri",
  "unlink",
  "shred",
]);
const WRITERS = new Set([
  ...REMOVE,
  "cp",
  "mv",
  "copy",
  "move",
  "xcopy",
  "robocopy",
  "copy-item",
  "cpi",
  "move-item",
  "mi",
  "rename-item",
  "ren",
  "rename",
  "rni",
  "ln",
  "touch",
  "mkdir",
  "md",
  "new-item",
  "ni",
  "tee",
  "set-content",
  "add-content",
  "out-file",
  "chmod",
  "attrib",
  "truncate",
  "dd",
  "tar",
  "zip",
  "unzip",
  "patch",
  "expand-archive",
  "compress-archive",
]);
const CHANGE_DIR = new Set(["cd", "pushd", "chdir", "set-location", "sl"]);
const CMD_BUILTINS = new Set([
  "del",
  "erase",
  "rd",
  "rmdir",
  "copy",
  "move",
  "xcopy",
  "robocopy",
  "type",
  "dir",
  "md",
  "mkdir",
  "ren",
  "rename",
  "findstr",
  "more",
]);
/** First positional argument is a pattern or script, not a path. */
const PATTERN_COMMANDS = new Set([
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "sed",
  "awk",
  "gawk",
  "jq",
  "yq",
  "select-string",
  "sls",
  "findstr",
]);
const PATTERN_FLAGS = new Set(["-e", "--regexp", "--expression", "-pattern"]);
/** Arguments are text, not paths (redirects are still checked). */
const TEXT_COMMANDS = new Set([
  "echo",
  "printf",
  "write-output",
  "write-host",
  "write-error",
  "export",
  "set",
  "unset",
  "declare",
  "typeset",
]);
/** `<tool> <subcommand> CMD...` runs CMD; flags listed take a value. */
const RUNNERS = {
  uv: {
    subcommands: new Set(["run"]),
    values: new Set([
      "--with",
      "--python",
      "-p",
      "--directory",
      "--project",
      "--package",
      "--extra",
      "--group",
      "--env-file",
    ]),
  },
  poetry: {
    subcommands: new Set(["run"]),
    values: new Set(["-C", "--directory"]),
  },
  pipenv: { subcommands: new Set(["run"]), values: new Set() },
  bundle: { subcommands: new Set(["exec"]), values: new Set() },
  pnpm: {
    subcommands: new Set(["exec", "dlx"]),
    values: new Set(["--package", "-C", "--dir"]),
  },
  yarn: {
    subcommands: new Set(["exec", "dlx"]),
    values: new Set(["--package", "-p"]),
  },
  npm: {
    subcommands: new Set(["exec", "x"]),
    values: new Set(["--package", "-p"]),
  },
  bun: { subcommands: new Set(["x"]), values: new Set() },
};
const REMOTE = new Set([
  "ssh",
  "scp",
  "sftp",
  "nc",
  "ncat",
  "netcat",
  "telnet",
  "ftp",
  "socat",
  "mosh",
  "rsync",
]);
const SYSTEM_PKG = new Set([
  "apt",
  "apt-get",
  "yum",
  "dnf",
  "pacman",
  "zypper",
  "apk",
  "brew",
  "snap",
  "choco",
  "winget",
  "scoop",
  "port",
  "rustup",
]);
const SYSTEM = new Set([
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "format",
  "diskpart",
  "fdisk",
  "mount",
  "umount",
  "reg",
  "regedit",
  "schtasks",
  "crontab",
  "at",
  "systemctl",
  "service",
  "launchctl",
  "sc",
  "netsh",
  "setx",
  "set-executionpolicy",
  "new-service",
  "set-service",
  "bcdedit",
  "iptables",
  "ufw",
  "chown",
  "icacls",
  "takeown",
  "mklink",
  "start-process",
]);
const HTTP = new Set([
  "curl",
  "wget",
  "iwr",
  "invoke-webrequest",
  "irm",
  "invoke-restmethod",
  "http",
  "https",
  "xh",
]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PIPS = new Set(["pip", "pip3"]);

/** Everything else a coding agent normally needs. Unknown names are refused. */
const ALLOWED = new Set([
  // shell and text
  "cd",
  "pushd",
  "popd",
  "chdir",
  "pwd",
  "echo",
  "printf",
  "true",
  "false",
  "test",
  "[",
  "exit",
  "export",
  "set",
  "unset",
  "source",
  ".",
  "type",
  "which",
  "where",
  "whereis",
  "sleep",
  "wait",
  "read",
  "clear",
  "cls",
  "date",
  "whoami",
  "hostname",
  "uname",
  "nproc",
  "ls",
  "dir",
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "sort",
  "uniq",
  "cut",
  "tr",
  "paste",
  "join",
  "comm",
  "diff",
  "cmp",
  "grep",
  "egrep",
  "fgrep",
  "rg",
  "ag",
  "ack",
  "find",
  "fd",
  "xargs",
  "sed",
  "awk",
  "gawk",
  "jq",
  "yq",
  "tree",
  "stat",
  "file",
  "du",
  "df",
  "basename",
  "dirname",
  "realpath",
  "readlink",
  "mktemp",
  "base64",
  "md5sum",
  "sha1sum",
  "sha256sum",
  "shasum",
  "column",
  "fold",
  "nl",
  "od",
  "xxd",
  "hexdump",
  "strings",
  "iconv",
  "dos2unix",
  "findstr",
  "gzip",
  "gunzip",
  "xz",
  ...WRITERS,
  // development tools
  "node",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "deno",
  "tsc",
  "tsx",
  "ts-node",
  "vite",
  "vitest",
  "jest",
  "mocha",
  "eslint",
  "prettier",
  "biome",
  "playwright",
  "python",
  "python3",
  "py",
  "pip",
  "pip3",
  "uv",
  "poetry",
  "pipenv",
  "pytest",
  "tox",
  "nox",
  "ruff",
  "black",
  "isort",
  "mypy",
  "pyright",
  "flake8",
  "pylint",
  "coverage",
  "alembic",
  "php",
  "composer",
  "phpunit",
  "pest",
  "ruby",
  "bundle",
  "rake",
  "rails",
  "rspec",
  "go",
  "gofmt",
  "cargo",
  "rustc",
  "java",
  "javac",
  "mvn",
  "gradle",
  "kotlin",
  "kotlinc",
  "dotnet",
  "make",
  "cmake",
  "ninja",
  "gcc",
  "g++",
  "clang",
  "cc",
  "swift",
  "flutter",
  "dart",
  "mix",
  "elixir",
  "perl",
  "sqlite3",
  "git",
  "gh",
  "docker",
  "docker-compose",
  "podman",
  ...HTTP,
  // PowerShell
  "get-content",
  "gc",
  "get-childitem",
  "gci",
  "select-string",
  "sls",
  "get-location",
  "gl",
  "set-location",
  "sl",
  "test-path",
  "get-item",
  "gi",
  "write-output",
  "write-host",
  "write-error",
  "measure-object",
  "measure",
  "select-object",
  "select",
  "where-object",
  "foreach-object",
  "%",
  "sort-object",
  "format-table",
  "ft",
  "format-list",
  "fl",
  "out-string",
  "convertto-json",
  "convertfrom-json",
  "get-date",
  "start-sleep",
  "join-path",
  "split-path",
  "resolve-path",
  "get-command",
  "gcm",
  // shells and interpreters (their own rules apply)
  ...INTERPRETERS,
]);

const ENV_DUMP = new Set([
  "env",
  "printenv",
  "export",
  "set",
  "declare",
  "typeset",
]);
const SENSITIVE_ENV =
  /^(GIT_\w*|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_\w*|NODE_OPTIONS|BASH_ENV|ENV|PROMPT_COMMAND|PYTHONSTARTUP|PERL5OPT|RUBYOPT|SSH_ASKPASS|SSH_AUTH_SOCK)$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const GIT_READ = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "grep",
  "ls-files",
  "ls-tree",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "cat-file",
  "show-ref",
  "add",
  "restore",
  "rm",
  "mv",
  "apply",
  "check-ignore",
  "check-attr",
  "diff-tree",
  "diff-files",
  "diff-index",
  "merge-base",
  "name-rev",
  "for-each-ref",
  "help",
  "version",
  "clean",
  "whatchanged",
  "range-diff",
]);
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add",
  "restore",
  "rm",
  "mv",
  "apply",
  "clean",
  "checkout",
  "reset",
  "stash",
]);
const GIT_HANDS_ONLY = new Set([
  "push",
  "pull",
  "fetch",
  "commit",
  "merge",
  "rebase",
  "cherry-pick",
  "revert",
  "am",
  "credential",
  "submodule",
  "worktree",
  "update-ref",
  "symbolic-ref",
  "filter-branch",
  "filter-repo",
  "replace",
  "gc",
  "prune",
  "init",
  "clone",
  "switch",
  "bisect",
  "notes",
  "lfs",
  "send-email",
  "request-pull",
  "daemon",
  "fast-import",
  "update-index",
]);
const GIT_BRANCH_LIST_FLAGS = new Set([
  "--list",
  "-l",
  "-a",
  "--all",
  "-r",
  "--remotes",
  "-v",
  "-vv",
  "--verbose",
  "--show-current",
  "--color",
  "--no-color",
  "--column",
  "--no-column",
]);
const GIT_BRANCH_VALUE_FLAGS = new Set([
  "--contains",
  "--no-contains",
  "--merged",
  "--no-merged",
  "--points-at",
  "--sort",
  "--format",
]);
const GIT_CONFIG_READ_FLAGS = new Set([
  "--get",
  "--get-all",
  "--get-regexp",
  "--list",
  "-l",
  "--show-origin",
  "--show-scope",
  "--name-only",
  "--null",
  "-z",
  "--global",
  "--local",
  "--system",
  "--worktree",
  "--includes",
  "--no-includes",
]);
const GH_READ = {
  pr: new Set(["view", "list", "diff", "checks", "status"]),
  issue: new Set(["view", "list", "status"]),
  run: new Set(["view", "list", "watch"]),
  repo: new Set(["view"]),
  workflow: new Set(["view", "list"]),
  release: new Set(["view", "list"]),
  search: new Set(["code", "issues", "prs", "repos", "commits"]),
};
const NULL_TARGETS = new Set([
  "/dev/null",
  "/dev/stdout",
  "/dev/stderr",
  "nul",
  "$null",
  "con",
]);

const SEPARATORS = new Set([
  "&&",
  "||",
  ";",
  "|",
  "&",
  "(",
  ")",
  "|&",
  ";;",
  "<(",
  ">(",
]);
const WRITE_REDIRECTS = new Set([">", ">>", ">|", "&>", "&>>"]);
const HEREDOCS = new Set(["<<", "<<-"]);
const SKIP_REDIRECTS = new Set(["<", "<<<", "<&"]);

const CREDENTIAL_PATH =
  /(^|[\s/"'=:])(\.ssh\/|\.aws\/credentials|\.git-credentials|\.netrc|_netrc|\.pgpass|\.docker\/config\.json|\.kube\/config|\.npmrc|\.pypirc|\.config\/gh\/hosts\.yml|\.azure\/|\.gnupg\/)/i;
// Agent-server and Hands state (saved LLM keys, sessions) in the home folder.
const HOME_STATE_PATH =
  /((~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|\$env:HOME|[a-z]:\/users\/[^/\s]+|\/home\/[^/\s]+|\/root|\/users\/[^/\s]+)\/|\.\.\/)(\.\.\/)*\.openhands(\/|\s|$|["'])/i;
const PROCESS_STATE =
  /\/proc\/(self|thread-self|\d+)\/(environ|cmdline|mem|fd|maps)/i;
const SECRET_VAR =
  /(\$\{?|\$env:|%)[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIAL|SESSION_KEY)/i;
const MAX_DEPTH = 4;

const BLOCKED_BROWSER_TOOLS = new Set([
  "browser_evaluate",
  "browser_run_code",
  "browser_run_code_unsafe",
  "browser_file_upload",
  "browser_set_storage_state",
  "browser_storage_state",
  "browser_route",
  "browser_unroute",
  "browser_install",
  "browser_network_state_set",
]);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Lower-case command name without directory or Windows extension. */
function commandName(token) {
  const base = String(token).split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.(exe|cmd|bat|ps1|com)$/, "");
}

/**
 * Backslashes become "/" so Windows paths survive shell-quote, which reads
 * a backslash as an escape. Escapes of quotes and shell operators are kept.
 */
function normaliseSlashes(line) {
  // A private-use character holds the kept escapes while the rest change.
  return line
    .replace(/\\(?=["'`$;|&<> ])/g, "")
    .replace(/\\/g, "/")
    .replace(//g, "\\");
}

const isFlag = (token) => token.startsWith("-") && token !== "-";
const isCmdFlag = (token) => /^\/[a-z?]{1,2}(:.*)?$/i.test(token);
const isUrl = (token) => /^[a-z][a-z0-9+.-]*:\/\//i.test(token);

/** True for arguments that name a path (absolute, relative with a folder, home, variable). */
function looksLikePath(token) {
  return (
    token.includes("/") ||
    /^(~|\.|[A-Za-z]:(\/|$))/.test(token) ||
    /^(\$HOME|\$\{HOME\}|%[A-Za-z_]+%|\$env:)/i.test(token)
  );
}

/** Where `target` lands, lexically; `inside` is false when it cannot be known. */
function resolveInside(target, ctx) {
  const value = String(target);
  if (/^~/.test(value) || value.includes("$") || /%[^%]+%/.test(value)) {
    return { inside: false };
  }
  const p = ctx.pathImpl ?? path;
  const resolved = p.resolve(ctx.worktreeDir, value);
  const rel = p.relative(ctx.worktreeDir, resolved);
  if (rel === "") return { inside: true, root: true, rel, resolved };
  const inside = !rel.startsWith("..") && !p.isAbsolute(rel);
  return { inside, root: false, rel, resolved };
}

/** Follows symlinks and junctions: the nearest existing part must stay inside. */
function realInside(resolved, ctx) {
  if ((ctx.pathImpl ?? path) !== path || !existsSync(ctx.worktreeDir)) {
    return true;
  }
  try {
    const root = realpathSync.native(ctx.worktreeDir);
    let probe = resolved;
    while (!existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) return true;
      probe = parent;
    }
    const real = realpathSync.native(probe);
    const rel = path.relative(root, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

const hasGitSegment = (rel) =>
  String(rel)
    .split(/[\\/]+/)
    .some((part) => part.toLowerCase() === ".git");

/** True when a dot-glob such as `.*` or `.g?t` could match ".git". */
function globMatchesGit(rel) {
  const base =
    String(rel)
      .split(/[\\/]+/)
      .pop() ?? "";
  if (!/[*?[]/.test(base) || !base.startsWith(".")) return false;
  const source = base
    .replace(/[.+^${}()|\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  try {
    return new RegExp(`^${source}$`, "i").test(".git");
  } catch {
    return true;
  }
}

function checkPath(target, ctx, { write = false, remove = false } = {}) {
  const value = String(target);
  if (NULL_TARGETS.has(value.toLowerCase())) return ALLOW;
  const where = resolveInside(value, ctx);
  if (!where.inside) return deny(REASONS.outside(value));
  if (remove && where.root) return deny(REASONS.worktreeRoot);
  if (
    (write || remove) &&
    (hasGitSegment(where.rel) || globMatchesGit(where.rel))
  ) {
    return deny(REASONS.gitDir);
  }
  if (!realInside(where.resolved, ctx)) return deny(REASONS.symlink(value));
  return ALLOW;
}

/**
 * Checks the arguments of an allowed command that name paths: positional
 * arguments, `--flag=value`, `-o../x` and `file:` URLs. Text commands,
 * patterns and inline code are skipped.
 */
function scanPaths(name, args, ctx, { write = false, remove = false } = {}) {
  if (TEXT_COMMANDS.has(name)) return ALLOW;
  let skipPattern =
    PATTERN_COMMANDS.has(name) &&
    !args.some((arg) => PATTERN_FLAGS.has(arg.toLowerCase()));
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (isFlag(arg) || (CMD_BUILTINS.has(name) && isCmdFlag(arg))) {
      const lower = arg.toLowerCase();
      if (
        PATTERN_FLAGS.has(lower) ||
        (INTERPRETERS.has(name) && CODE_FLAGS.has(arg))
      ) {
        i += 1; // the next token is a pattern or inline code
        continue;
      }
      let value = null;
      const eq = arg.indexOf("=");
      if (eq > 0) value = arg.slice(eq + 1);
      else if (/^-[A-Za-z](~|\.|\/|[A-Za-z]:\/)/.test(arg))
        value = arg.slice(2);
      if (
        value !== null &&
        value &&
        (looksLikePath(value) || /^file:/i.test(value))
      ) {
        const result = checkPath(value.replace(/^file:\/*/i, "/"), ctx, {
          write,
        });
        if (!result.allow) return result;
      }
      continue;
    }
    if (skipPattern) {
      skipPattern = false;
      continue;
    }
    if (isUrl(arg) || /^file:/i.test(arg)) {
      if (/^file:/i.test(arg)) {
        const result = checkPath(arg.replace(/^file:\/*/i, "/"), ctx);
        if (!result.allow) return result;
      }
      continue;
    }
    const existing =
      (ctx.pathImpl ?? path) === path &&
      !arg.includes("$") &&
      existsSync(path.resolve(ctx.worktreeDir, arg));
    // Every positional argument of a write or delete command is a path.
    if (looksLikePath(arg) || existing || write || remove) {
      const result = checkPath(arg, ctx, { write, remove });
      if (!result.allow) return result;
    }
  }
  return ALLOW;
}

/** Splits one line into simple commands, redirect targets and here-doc words. */
function splitLine(line) {
  const tokens = parse(
    normaliseSlashes(line).replace(/`/g, " ; "),
    (key) => `$${key}`,
  );
  const segments = [];
  const heredocs = [];
  let current = { words: [], writes: [], fromPipe: false };
  let next = null; // "write" | "skip" | "heredoc" | "fd"
  const take = (word) => {
    if (next === "write") current.writes.push(word);
    else if (next === "heredoc") heredocs.push(word);
    else if (next === "fd") {
      // `>&2` names a descriptor; anything else is a file.
      if (!/^\d+$|^-$/.test(word)) current.writes.push(word);
    } else if (next !== "skip") current.words.push(word);
    next = null;
  };
  for (const token of tokens) {
    if (typeof token === "object" && token !== null) {
      if ("comment" in token) {
        // shell-quote starts comments mid-word (`x#; cmd`), bash does not:
        // check the comment text as commands too.
        segments.push(...splitLine(token.comment).segments);
        break;
      }
      const { op } = token;
      if (op === "glob") {
        take(token.pattern);
        continue;
      }
      if (SEPARATORS.has(op)) {
        if (current.words.length > 0 || current.writes.length > 0) {
          segments.push(current);
        }
        current = {
          words: [],
          writes: [],
          fromPipe: op === "|" || op === "|&",
        };
        next = null;
        continue;
      }
      if (WRITE_REDIRECTS.has(op)) next = "write";
      else if (op === ">&") next = "fd";
      else if (HEREDOCS.has(op)) next = "heredoc";
      else if (SKIP_REDIRECTS.has(op)) next = "skip";
      continue;
    }
    take(String(token));
  }
  if (current.words.length > 0 || current.writes.length > 0) {
    segments.push(current);
  }
  return { segments, heredocs };
}

/** All simple commands in a raw command; here-document bodies are skipped. */
function commandSegments(command) {
  const lines = String(command)
    .replace(/\\\r?\n/g, " ")
    .split(/\r?\n/);
  const segments = [];
  const pending = [];
  for (const line of lines) {
    if (pending.length > 0) {
      if (line.replace(/^\t+/, "").trim() === pending[0]) pending.shift();
      continue;
    }
    const parsed = splitLine(line);
    segments.push(...parsed.segments);
    pending.push(...parsed.heredocs);
  }
  return segments;
}

// ── Per-command rules ───────────────────────────────────────────────────────

function checkGit(args, ctx, { readOnly }) {
  let i = 0;
  while (i < args.length && isFlag(args[i])) {
    const flag = args[i];
    if (flag === "-C") {
      const dir = checkPath(args[i + 1] ?? "", ctx);
      if (!dir.allow) return dir;
      i += 2;
      continue;
    }
    if (
      flag === "-c" ||
      /^--(git-dir|work-tree|exec-path|config-env|namespace|super-prefix)/.test(
        flag,
      )
    ) {
      return deny(REASONS.git);
    }
    i += 1;
  }
  const sub = (args[i] ?? "").toLowerCase();
  const rest = args.slice(i + 1);
  if (!sub) return ALLOW;
  if (readOnly && GIT_WRITE_SUBCOMMANDS.has(sub)) return deny(REASONS.readOnly);
  if (GIT_HANDS_ONLY.has(sub) || sub.startsWith("credential")) {
    return deny(REASONS.git);
  }
  const paths = () =>
    scanPaths("git", rest, ctx, { write: GIT_WRITE_SUBCOMMANDS.has(sub) });
  switch (sub) {
    case "checkout":
      return rest.includes("--") ? paths() : deny(REASONS.git);
    case "branch": {
      for (let j = 0; j < rest.length; j += 1) {
        const [flag] = rest[j].split("=");
        if (GIT_BRANCH_VALUE_FLAGS.has(flag)) {
          if (!rest[j].includes("=")) j += 1;
          continue;
        }
        if (!GIT_BRANCH_LIST_FLAGS.has(flag)) return deny(REASONS.git);
      }
      return ALLOW;
    }
    case "tag":
      return rest.length > 0 &&
        rest.every(
          (arg, j) =>
            ["-l", "--list", "-n"].includes(arg) || (j > 0 && !isFlag(arg)),
        )
        ? ALLOW
        : deny(REASONS.git);
    case "remote":
      return rest.length === 0 ||
        rest.every((arg) => ["-v", "--verbose"].includes(arg)) ||
        (rest[0] === "get-url" && rest.length <= 2)
        ? ALLOW
        : deny(REASONS.git);
    case "config": {
      const flags = rest.filter(isFlag).map((flag) => flag.split("=")[0]);
      const positional = rest.filter((arg) => !isFlag(arg));
      const readsOnly =
        flags.every(
          (flag) =>
            GIT_CONFIG_READ_FLAGS.has(flag) ||
            flag === "--type" ||
            flag === "--default",
        ) &&
        (flags.some((flag) => /^--get|^--list$|^-l$/.test(flag)) ||
          positional.length === 1);
      return readsOnly ? ALLOW : deny(REASONS.git);
    }
    case "reset": {
      // Unstage only: `git reset [-q] [HEAD] [-- paths]`.
      const dash = rest.indexOf("--");
      const before = dash < 0 ? rest : rest.slice(0, dash);
      const ok = before.every(
        (arg) => arg === "-q" || arg === "--quiet" || arg === "HEAD",
      );
      return ok ? paths() : deny(REASONS.git);
    }
    case "stash":
      return ["clear", "drop"].includes(rest[0]) ? deny(REASONS.git) : ALLOW;
    case "reflog":
      return ["expire", "delete"].includes(rest[0]) ? deny(REASONS.git) : ALLOW;
    default:
      return GIT_READ.has(sub) ? paths() : deny(REASONS.gitUnknown);
  }
}

function checkGh(args) {
  const [group, action] = args.map((arg) => arg.toLowerCase());
  if (group === "api") {
    if (action === "graphql") return deny(REASONS.gh);
    for (let i = 1; i < args.length; i += 1) {
      const arg = args[i];
      if (/^(-f|-F|--field|--raw-field|--input)/.test(arg))
        return deny(REASONS.gh);
      let method = null;
      if (/^-X./.test(arg)) method = arg.slice(2);
      else if (arg === "-X" || arg === "--method") method = args[i + 1] ?? "";
      else if (arg.startsWith("--method=")) method = arg.slice(9);
      if (method !== null && !/^(GET|HEAD)$/i.test(method))
        return deny(REASONS.gh);
    }
    return ALLOW;
  }
  if (group === "auth") {
    return action === "status" &&
      !args.some((arg) => /^(-t|--show-token)$/.test(arg))
      ? ALLOW
      : deny(REASONS.gh);
  }
  return GH_READ[group]?.has(action) ? ALLOW : deny(REASONS.gh);
}

function checkHttp(name, args) {
  let method = null;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (
      /^--(json|data|form|upload-file|post-data|post-file|body-data|body-file|config)/i.test(
        arg,
      ) ||
      (name === "curl" && /^-(d|F|T|K)/.test(arg)) ||
      ["-infile", "-body", "-form"].includes(lower)
    ) {
      return deny(REASONS.upload);
    }
    if (name === "curl" && /^-X./.test(arg)) method = arg.slice(2);
    else if (
      ["-x", "--request", "--method", "-method"].includes(lower) &&
      (name !== "curl" || arg === "-X" || lower !== "-x")
    ) {
      method = args[i + 1] ?? "";
    } else if (/^--(request|method)=/i.test(arg)) method = arg.split("=")[1];
  }
  if (method !== null && !/^(GET|HEAD)$/i.test(method))
    return deny(REASONS.upload);
  if (["http", "https", "xh"].includes(name)) {
    // httpie sends a body (and POSTs) when given data items.
    const positional = args.filter((arg) => !isFlag(arg));
    const plain =
      positional.length === 1 ||
      (positional.length === 2 && /^(GET|HEAD)$/i.test(positional[0]));
    if (!plain) return deny(REASONS.upload);
  }
  return ALLOW;
}

function checkPip(runner, args) {
  if (!args.includes("install")) return ALLOW;
  if (
    args.includes("--user") ||
    args.some((arg) => /^--(prefix|root|target)/.test(arg))
  ) {
    return deny(REASONS.globalInstall);
  }
  const inVenv = /(^|\/)\.?venv\d*\/|(^|\/)env\//i.test(runner);
  return inVenv ? ALLOW : deny(REASONS.globalInstall);
}

function checkDocker(args, ctx) {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (
      /^--(privileged|cap-add|security-opt|device|pid|ipc|uts|userns|cgroupns)/.test(
        lower,
      ) ||
      (/^--(net|network)(=host|$)/.test(lower) &&
        (lower.includes("=host") || args[i + 1] === "host")) ||
      /docker\.sock/.test(lower)
    ) {
      return deny(REASONS.dockerHost);
    }
    let source = null;
    if (lower === "-v" || lower === "--volume")
      source = (args[i + 1] ?? "").replace(/^([A-Za-z]:)?([^:]*).*$/, "$1$2");
    else if (/^(-v|--volume)=/.test(lower))
      source = arg.split("=")[1].replace(/^([A-Za-z]:)?([^:]*).*$/, "$1$2");
    else if (lower === "--mount" || lower.startsWith("--mount=")) {
      const spec = lower === "--mount" ? (args[i + 1] ?? "") : arg.slice(8);
      const match = /(?:^|,)(?:src|source)=([^,]+)/i.exec(spec);
      source = match ? match[1] : null;
    }
    // Named volumes have no slash; host folders must be inside the worktree.
    if (source && looksLikePath(source) && !checkPath(source, ctx).allow) {
      return deny(REASONS.dockerHost);
    }
  }
  return ALLOW;
}

function isPackageInstall(name, args) {
  if (PACKAGE_MANAGERS.has(name)) {
    return [
      "install",
      "i",
      "ci",
      "add",
      "remove",
      "uninstall",
      "rm",
      "update",
      "upgrade",
    ].includes(args[0]);
  }
  if (PIPS.has(name)) return args[0] === "install" || args[0] === "uninstall";
  if (name === "uv") return ["add", "remove", "sync", "pip"].includes(args[0]);
  if (name === "composer" || name === "bundle" || name === "poetry") {
    return ["install", "require", "add", "update", "remove"].includes(args[0]);
  }
  return false;
}

/** Checks one simple command. */
function checkSimple(segment, ctx, depth) {
  for (const target of segment.writes) {
    if (ctx.readOnly && !NULL_TARGETS.has(String(target).toLowerCase())) {
      return deny(REASONS.readOnly);
    }
    const result = checkPath(target, ctx, { write: true });
    if (!result.allow) return result;
  }
  const words = [...segment.words];
  while (words.length > 0 && ASSIGNMENT.test(words[0])) {
    if (SENSITIVE_ENV.test(words[0].split("=")[0]))
      return deny(REASONS.envOverride);
    words.shift();
  }
  if (words.length === 0) return ALLOW;
  return checkWords(words, ctx, depth, segment.fromPipe);
}

function checkWords(words, ctx, depth, fromPipe = false) {
  if (depth > MAX_DEPTH) return deny(REASONS.tooDeep);
  let index = 0;

  // Wrappers run the command after them; skip their own options.
  for (;;) {
    const wrapper = commandName(words[index] ?? "");
    if (wrapper === "env") {
      const rest = [];
      for (let i = index + 1; i < words.length; i += 1) {
        const arg = words[i];
        if (/^(-S|--split-string)/.test(arg)) {
          const text = arg.includes("=")
            ? arg.slice(arg.indexOf("=") + 1)
            : arg.length > 2 && !arg.startsWith("--")
              ? arg.slice(2)
              : words[(i += 1)];
          return checkCommandAt(
            [text ?? "", ...words.slice(i + 1)].join(" "),
            ctx,
            depth + 1,
          );
        }
        if (/^(-u|--unset|-C|--chdir)$/.test(arg)) {
          if (
            /^(-C|--chdir)$/.test(arg) &&
            !checkPath(words[i + 1] ?? "", ctx).allow
          ) {
            return deny(REASONS.outside(words[i + 1] ?? ""));
          }
          i += 1;
          continue;
        }
        if (isFlag(arg)) continue;
        if (ASSIGNMENT.test(arg)) {
          if (SENSITIVE_ENV.test(arg.split("=")[0]))
            return deny(REASONS.envOverride);
          continue;
        }
        rest.push(...words.slice(i));
        break;
      }
      if (rest.length === 0) return deny(REASONS.envDump);
      return checkWords(rest, ctx, depth + 1, fromPipe);
    }
    const valueFlags = WRAPPERS[wrapper];
    if (!valueFlags) break;
    if (wrapper === "command" && /^-[vV]$/.test(words[index + 1] ?? ""))
      return ALLOW;
    index += 1;
    while (index < words.length && isFlag(words[index])) {
      const flag = words[index];
      const [name] = flag.split("=");
      if (wrapper === "npx" && /^(-c|--call)$/.test(name)) {
        const text = flag.includes("=")
          ? flag.slice(flag.indexOf("=") + 1)
          : words[index + 1];
        return checkCommandAt(text ?? "", ctx, depth + 1);
      }
      index += 1;
      if (valueFlags.has(name) && !flag.includes("=")) {
        if (wrapper === "time" && /^(-o|--output)$/.test(name)) {
          const result = checkPath(words[index] ?? "", ctx, { write: true });
          if (!result.allow) return result;
        }
        index += 1;
      }
    }
    if (wrapper === "timeout") index += 1; // the duration
  }
  if (index >= words.length) return ALLOW;

  const rawName = words[index];
  const args = words.slice(index + 1);

  // PowerShell `$env:NAME = value` sets a variable; other `$` names are dynamic.
  const envSet = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(=.*)?$/i.exec(rawName);
  if (
    envSet &&
    (envSet[2] !== undefined || args[0] === "=" || args[0]?.startsWith("="))
  ) {
    return SENSITIVE_ENV.test(envSet[1]) ? deny(REASONS.envOverride) : ALLOW;
  }
  if (/[$`]/.test(rawName)) return deny(REASONS.dynamicName);

  const name = commandName(rawName);
  if (name.startsWith("git-")) return deny(REASONS.git);

  // `uv run CMD`, `bundle exec CMD`, `pnpm dlx PKG`: check what they start.
  const runner = RUNNERS[name];
  if (runner?.subcommands.has(args[0])) {
    let i = 1;
    while (i < args.length && (isFlag(args[i]) || args[i] === "--")) {
      const flag = args[i];
      if (/^(-c|--call)(=|$)/.test(flag)) {
        const text = flag.includes("=")
          ? flag.slice(flag.indexOf("=") + 1)
          : args[i + 1];
        return checkCommandAt(text ?? "", ctx, depth + 1);
      }
      i += runner.values.has(flag.split("=")[0]) && !flag.includes("=") ? 2 : 1;
    }
    return i < args.length
      ? checkWords(args.slice(i), ctx, depth + 1, fromPipe)
      : ALLOW;
  }

  // A script inside the worktree (./run.sh, node_modules/.bin/vitest). It
  // must exist (or start with ./ when there is no real folder), so an escaped
  // name such as g\it, read as "g/it", is not mistaken for one.
  const where = rawName.includes("/") ? resolveInside(rawName, ctx) : null;
  const realFolder =
    (ctx.pathImpl ?? path) === path && existsSync(ctx.worktreeDir);
  if (
    where?.inside &&
    (realFolder ? existsSync(where.resolved) : /^\.\.?\//.test(rawName))
  ) {
    const result = checkPath(rawName, ctx);
    if (!result.allow) return result;
    if (ctx.readOnly) return deny(REASONS.readOnly);
    return scanPaths(name, args, ctx);
  }

  if (RUN_AS.has(name)) return deny(REASONS.sudo);
  if (EVAL.has(name)) return deny(REASONS.evalCode);
  if (name === "printenv") return deny(REASONS.envDump);
  if (ENV_DUMP.has(name)) {
    const names = args.filter((arg) => !isFlag(arg));
    if (names.length === 0) return deny(REASONS.envDump);
    if (names.some((arg) => SENSITIVE_ENV.test(arg.split("=")[0]))) {
      return deny(REASONS.envOverride);
    }
  }
  if (
    [
      "get-childitem",
      "gci",
      "ls",
      "dir",
      "get-item",
      "gi",
      "get-content",
      "gc",
      "cat",
      "type",
    ].includes(name) &&
    args.some((arg) => /^env:/i.test(arg))
  ) {
    return deny(REASONS.envDump);
  }
  if (REMOTE.has(name)) return deny(REASONS.remote);
  if (
    SYSTEM_PKG.has(name) ||
    (["pipx", "gem", "cargo", "go"].includes(name) && args[0] === "install")
  ) {
    return deny(REASONS.globalInstall);
  }
  if (SYSTEM.has(name) || name.startsWith("mkfs")) {
    return name === "mklink" || name === "start-process"
      ? deny(REASONS.link)
      : deny(REASONS.system);
  }
  if (
    ["new-item", "ni"].includes(name) &&
    args.some((arg) => /^(symboliclink|junction|hardlink)$/i.test(arg))
  ) {
    return deny(REASONS.link);
  }
  if (ctx.readOnly && (WRITERS.has(name) || isPackageInstall(name, args))) {
    return deny(REASONS.readOnly);
  }
  if (
    ctx.readOnly &&
    (name === "sed" || name === "perl") &&
    args.some((arg) => /^-i/.test(arg) || /^--in-place/.test(arg))
  ) {
    return deny(REASONS.readOnly);
  }

  if (
    PACKAGE_MANAGERS.has(name) &&
    (args.includes("-g") || args.includes("--global") || args[0] === "global")
  ) {
    return deny(REASONS.globalInstall);
  }

  // Shells and interpreters: inspect inline commands, refuse stdin scripts.
  if (INTERPRETERS.has(name)) {
    if (SHELLS.has(name)) {
      const flagIndex = args.findIndex((arg) => /^-[a-z]*c[a-z]*$/i.test(arg));
      if (flagIndex >= 0) {
        return checkCommandAt(args[flagIndex + 1] ?? "", ctx, depth + 1);
      }
    }
    if (POWERSHELLS.has(name)) {
      const switches = args.map((arg) => arg.toLowerCase());
      if (
        switches.some((arg) =>
          /^[-/](e|ec|ea|en\w*|encodedcommand|encodedarguments)$/.test(arg),
        )
      ) {
        return deny(REASONS.nestedShell);
      }
      const flagIndex = switches.findIndex((arg) =>
        /^[-/]c(o(m(m(a(n(d)?)?)?)?)?)?$/.test(arg),
      );
      if (flagIndex >= 0) {
        const text = args.slice(flagIndex + 1).join(" ");
        if (text.trim() === "-") return deny(REASONS.stdinShell);
        return checkCommandAt(text, ctx, depth + 1);
      }
    }
    if (name === "cmd") {
      const flagIndex = args.findIndex((arg) => /^\/(c|k|r)$/i.test(arg));
      if (flagIndex >= 0) {
        return checkCommandAt(
          args.slice(flagIndex + 1).join(" "),
          ctx,
          depth + 1,
        );
      }
    }
    // "-" means "read the script from standard input".
    const positional = args.filter(
      (arg, i) =>
        arg !== "-" && !isFlag(arg) && !(i > 0 && CODE_FLAGS.has(args[i - 1])),
    );
    const inline = args.some((arg) => CODE_FLAGS.has(arg));
    if (positional.length === 0 && !inline) return deny(REASONS.stdinShell);
    if (
      ["python", "python3", "py"].includes(name) &&
      args[0] === "-m" &&
      PIPS.has(args[1])
    ) {
      return checkPip(rawName, args.slice(2));
    }
    return scanPaths(name, args, ctx);
  }

  if (name === "git") return checkGit(args, ctx, { readOnly: ctx.readOnly });
  if (name === "gh") return checkGh(args);
  if (HTTP.has(name)) {
    const result = checkHttp(name, args);
    return result.allow ? scanPaths(name, args, ctx, { write: true }) : result;
  }
  if (name === "docker" || name === "podman" || name === "docker-compose") {
    const result = checkDocker(args, ctx);
    return result.allow ? scanPaths(name, args, ctx) : result;
  }
  if (PIPS.has(name) || /^pip3\.\d+$/.test(name)) {
    const result = checkPip(rawName, args);
    return result.allow ? scanPaths(name, args, ctx) : result;
  }
  if (name === "uv" && args[0] === "pip" && args.includes("--system"))
    return deny(REASONS.globalInstall);
  if (name === "uv" && args[0] === "tool" && args[1] === "install")
    return deny(REASONS.globalInstall);
  if (name === "dd") {
    const target = args.find((arg) => arg.startsWith("of="));
    if (target) return checkPath(target.slice(3), ctx, { write: true });
  }

  if (CHANGE_DIR.has(name)) {
    const target = args.find((arg) => !isFlag(arg));
    if (!target || target === "-") return deny(REASONS.outside(target ?? "~"));
    return checkPath(target, ctx);
  }

  // find: -exec runs a command; -delete removes what it finds.
  if (name === "find") {
    if (args.includes("-delete")) {
      for (const start of args.slice(
        0,
        Math.max(
          0,
          args.findIndex((arg) => /^[-(!]/.test(arg)),
        ),
      )) {
        const result = checkPath(start, ctx, { remove: true });
        if (!result.allow) return result;
      }
    }
    for (let i = 0; i < args.length; i += 1) {
      if (/^-(exec|execdir|ok|okdir)$/.test(args[i])) {
        const end = args.findIndex(
          (arg, j) => j > i && /^(\\?;|\/;|\+)$/.test(arg),
        );
        const inner = args.slice(i + 1, end < 0 ? undefined : end);
        const result = checkWords(inner, ctx, depth + 1);
        if (!result.allow) return result;
      }
    }
    return scanPaths(
      name,
      args.filter((arg) => arg !== "{}"),
      ctx,
      { write: true },
    );
  }
  // xargs runs the rest of its line as a command; check every reading of it.
  if (name === "xargs") {
    for (let i = 0; i < args.length; i += 1) {
      if (isFlag(args[i])) continue;
      const result = checkWords(args.slice(i), ctx, depth + 1);
      if (!result.allow) return result;
    }
    return ALLOW;
  }

  if (!ALLOWED.has(name)) return deny(REASONS.unknownCommand(name));

  const sedInPlace =
    (name === "sed" || name === "perl") &&
    args.some((arg) => /^-i|^--in-place/.test(arg));
  return scanPaths(name, args, ctx, {
    write: WRITERS.has(name) || sedInPlace,
    remove: REMOVE.has(name),
  });
}

function checkCommandAt(command, ctx, depth) {
  if (depth > MAX_DEPTH) return deny(REASONS.tooDeep);
  const raw = normaliseSlashes(String(command));
  if (
    CREDENTIAL_PATH.test(raw) ||
    SECRET_VAR.test(raw) ||
    HOME_STATE_PATH.test(raw) ||
    PROCESS_STATE.test(raw)
  ) {
    return deny(REASONS.secrets);
  }
  for (const segment of commandSegments(command)) {
    const result = checkSimple(segment, ctx, depth);
    if (!result.allow) return result;
  }
  return ALLOW;
}

/**
 * Checks a shell command an agent wants to run in the worktree.
 * @param {string} command
 * @param {{ worktreeDir: string, pathImpl?: typeof path, readOnly?: boolean }} ctx
 * @returns {{ allow: true } | { allow: false, reason: string }}
 */
export function checkCommand(command, ctx) {
  return checkCommandAt(command, ctx, 0);
}

// ── Tool actions ────────────────────────────────────────────────────────────

const SAFE_KINDS = new Set([
  "FinishAction",
  "ThinkAction",
  "TaskTrackerAction",
  "InvokeSkillAction",
  "VisionInspectAction",
  "AskOracleAction",
  "SwitchLLMAction",
  "ClassifyAndSwitchLLMAction",
  "MessageAction",
]);
const SUB_AGENT_KINDS = new Set([
  "DelegateAction",
  "StartChildConversationAction",
  "TaskAction",
  "WorkflowAction",
]);
const FILE_EDITOR_KINDS = new Set([
  "FileEditorAction",
  "PlanningFileEditorAction",
]);

const httpOnly = (url) =>
  /^(https?:\/\/|about:blank$)/i.test(String(url ?? ""));

/**
 * Checks one pending ActionEvent from the Agent Server.
 * @param {{ tool_name?: string, action?: Record<string, any> | null }} event
 * @param {{ worktreeDir: string, pathImpl?: typeof path, readOnly?: boolean }} ctx
 */
export function checkAction(event, ctx) {
  const action = event?.action ?? {};
  const kind = String(action.kind ?? "");
  if (SAFE_KINDS.has(kind)) return ALLOW;
  if (kind.startsWith("Browser")) {
    if (kind === "BrowserNavigateAction" && !httpOnly(action.url)) {
      return deny(REASONS.browserUrl);
    }
    return ALLOW;
  }
  if (SUB_AGENT_KINDS.has(kind)) return deny(REASONS.subAgent);
  if (kind === "TerminalAction") {
    return checkCommand(String(action.command ?? ""), ctx);
  }
  if (FILE_EDITOR_KINDS.has(kind)) {
    const write = action.command !== "view";
    if (write && ctx.readOnly) return deny(REASONS.readOnly);
    return checkPath(String(action.path ?? ""), ctx, { write });
  }
  if (kind === "EditAction" || kind === "WriteFileAction") {
    if (ctx.readOnly) return deny(REASONS.readOnly);
    return checkPath(String(action.file_path ?? ""), ctx, { write: true });
  }
  if (kind === "ReadFileAction") {
    return checkPath(String(action.file_path ?? ""), ctx);
  }
  if (kind === "ListDirectoryAction") {
    return checkPath(String(action.dir_path ?? "."), ctx);
  }
  if (kind === "GlobAction" || kind === "GrepAction") {
    return action.path ? checkPath(String(action.path), ctx) : ALLOW;
  }
  if (kind === "MCPToolAction") {
    const name = String(event?.tool_name ?? "").toLowerCase();
    if (!/^browser_/.test(name))
      return deny(REASONS.mcpTool(name || "unknown"));
    if (BLOCKED_BROWSER_TOOLS.has(name)) return deny(REASONS.browserTool(name));
    const data = action.data ?? action.arguments ?? {};
    if (/\bfile:/i.test(JSON.stringify(data))) return deny(REASONS.browserUrl);
    if (
      name === "browser_navigate" &&
      data.url !== undefined &&
      !httpOnly(data.url)
    ) {
      return deny(REASONS.browserUrl);
    }
    return ALLOW;
  }
  return deny(REASONS.unknownTool(kind || "unknown"));
}
