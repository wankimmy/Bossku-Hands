// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createGit, writeAskpassScript } from "../../../scripts/hands/git.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

// The askpass helper is a POSIX shell script (used in Docker); Git for
// Windows ships sh, so it can be exercised here too when sh is on PATH.
const hasSh = spawnSync("sh", ["-c", "exit 0"]).status === 0;

describe("Hands git: push credentials", () => {
  it("passes the push environment only to the push command", async () => {
    const seen: Array<{ args: string[]; env?: Record<string, string> }> = [];
    const git = createGit({
      run: async (args, options) => {
        seen.push({ args, env: options.env });
        return args[0] === "rev-parse" ? "hands/abc123\n" : "";
      },
      pushEnv: () => ({
        GIT_ASKPASS: "/data/git-askpass.sh",
        GIT_TERMINAL_PROMPT: "0",
      }),
    });

    await git.pushBranch("/wt", "hands/abc123", undefined, "/repo");

    const push = seen.find((call) => call.args[0] === "push")!;
    expect(push.env).toMatchObject({ GIT_ASKPASS: "/data/git-askpass.sh" });
    const other = seen.find((call) => call.args[0] === "rev-parse")!;
    expect(other.env).toBeUndefined();
  });

  describe.skipIf(!hasSh)("askpass helper", () => {
    function askpass() {
      const dir = mkdtempSync(path.join(tmpdir(), "hands-askpass-"));
      dirs.push(dir);
      const script = writeAskpassScript(dir);
      const env = { ...process.env, BOSSKU_HANDS_ASKPASS_TOKEN: "t0k" };
      const ask = (prompt: string) => {
        const result = spawnSync("sh", [script, prompt], {
          env,
          encoding: "utf8",
        });
        return { status: result.status, out: result.stdout.trim() };
      };
      return { script, ask };
    }

    it("answers github.com prompts with the token from its environment", () => {
      const { ask } = askpass();
      expect(ask("Username for 'https://github.com': ")).toEqual({
        status: 0,
        out: "x-access-token",
      });
      expect(ask("Password for 'https://x-access-token@github.com': ")).toEqual(
        { status: 0, out: "t0k" },
      );
    });

    it("never gives the token to any other host", () => {
      const { ask } = askpass();
      for (const prompt of [
        "Username for 'https://gitlab.com': ",
        "Password for 'https://x-access-token@gitlab.com': ",
        "Password for 'https://x-access-token@github.com.evil.example': ",
        "Password for 'http://x-access-token@github.com': ",
        "Enter passphrase for key '/home/u/.ssh/id_ed25519': ",
      ]) {
        const result = ask(prompt);
        expect(result.out, prompt).not.toContain("t0k");
        expect(result.status, prompt).not.toBe(0);
      }
    });

    it.skipIf(process.platform === "win32")("is private to its owner", () => {
      const { script } = askpass();
      expect(statSync(script).mode & 0o777).toBe(0o700);
    });
  });

  it("the script itself holds no secret", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "hands-askpass-"));
    dirs.push(dir);
    const script = writeAskpassScript(dir);
    expect(
      execFileSync(
        process.execPath,
        [
          "-e",
          `process.stdout.write(require("fs").readFileSync(${JSON.stringify(script)},"utf8"))`,
        ],
        { encoding: "utf8" },
      ),
    ).not.toMatch(/t0k|ghp_/);
  });
});
