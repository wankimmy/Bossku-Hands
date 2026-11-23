// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  createGithubClient,
  parseGithubRemote,
} from "../../../scripts/hands/github.mjs";

type Route = (init: RequestInit) => Response | Promise<Response>;

/** A fetch stand-in that answers by "METHOD path" and records each call. */
function fakeFetch(routes: Record<string, Route>) {
  const calls: Array<{ key: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname, search } = new URL(url);
    const key = `${init.method} ${pathname}${search}`;
    calls.push({ key, init });
    const route = routes[key];
    if (!route) return new Response("not found", { status: 404 });
    return route(init);
  });
  return { fetchImpl, calls };
}

const json = (value: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

const REMOTE = "https://github.com/acme/demo.git";
const client = (
  routes: Record<string, Route>,
  token: string | null = "t0k",
) => {
  const fake = fakeFetch(routes);
  return {
    ...fake,
    github: createGithubClient({
      getToken: () => token,
      fetchImpl: fake.fetchImpl as unknown as typeof fetch,
    }),
  };
};

describe("Hands GitHub client", () => {
  it("reads owner and repo from https and ssh github remotes only", () => {
    expect(parseGithubRemote(REMOTE)).toEqual({ owner: "acme", repo: "demo" });
    expect(parseGithubRemote("git@github.com:acme/demo.git")).toEqual({
      owner: "acme",
      repo: "demo",
    });
    expect(() => parseGithubRemote("https://gitlab.com/acme/demo.git")).toThrow(
      expect.objectContaining({ code: "unsupported_remote" }),
    );
  });

  it("finds an open PR for the branch before opening a new draft", async () => {
    const { github, calls } = client({
      "GET /repos/acme/demo/pulls?state=open&head=acme%3Ahands%2Fabc": () =>
        json([]),
      "POST /repos/acme/demo/pulls": () =>
        json({ number: 12, html_url: "https://github.com/acme/demo/pull/12" }),
    });

    expect(
      await github.findPull({ remoteUrl: REMOTE, head: "hands/abc" }),
    ).toBeNull();
    const pull = await github.createPull({
      remoteUrl: REMOTE,
      head: "hands/abc",
      base: "main",
      title: "Add hello",
      body: "body",
      draft: true,
    });

    expect(pull).toEqual({
      number: 12,
      url: "https://github.com/acme/demo/pull/12",
    });
    const post = calls.find(
      (call) => call.key === "POST /repos/acme/demo/pulls",
    )!;
    expect(JSON.parse(String(post.init.body))).toMatchObject({
      head: "hands/abc",
      base: "main",
      draft: true,
    });
    expect((post.init.headers as Record<string, string>).authorization).toBe(
      "Bearer t0k",
    );
  });

  it("reports pending, success, none and failure with the job log tail", async () => {
    const runs: unknown[][] = [
      [{ id: 1, name: "test", status: "in_progress", conclusion: null }],
      [{ id: 1, name: "test", status: "completed", conclusion: "success" }],
      [],
      [
        {
          id: 77,
          name: "unit-tests",
          status: "completed",
          conclusion: "failure",
          app: { slug: "github-actions" },
          output: { title: "1 test failed", summary: "" },
        },
        { id: 78, name: "lint", status: "completed", conclusion: "skipped" },
      ],
    ];
    const { github } = client({
      "GET /repos/acme/demo/pulls/12": () =>
        json({ state: "open", merged: false, head: { sha: "abc123" } }),
      "GET /repos/acme/demo/commits/abc123/check-runs?per_page=100": () =>
        json({ check_runs: runs.shift() }),
      "GET /repos/acme/demo/actions/jobs/77/logs": () =>
        new Response("setup...\nFAIL greets\nExpected 'hi' to be 'hello'"),
    });
    const read = () => github.getPullStatus({ remoteUrl: REMOTE, number: 12 });

    expect((await read()).ci).toEqual({ status: "pending" });
    expect((await read()).ci).toEqual({ status: "success" });
    expect((await read()).ci).toEqual({ status: "none" });
    const failed = await read();
    expect(failed).toMatchObject({
      state: "open",
      merged: false,
      headSha: "abc123",
    });
    expect(failed.ci).toEqual({
      status: "failure",
      failures: [
        {
          name: "unit-tests",
          conclusion: "failure",
          summary: expect.stringContaining("Expected 'hi' to be 'hello'"),
        },
      ],
    });
  });

  it("keeps only https://github.com links from PR responses", async () => {
    const { github } = client({
      "POST /repos/acme/demo/pulls": () =>
        json({ number: 13, html_url: "javascript:alert(1)" }),
    });

    const pull = await github.createPull({
      remoteUrl: REMOTE,
      head: "hands/abc",
      base: "main",
      title: "t",
      body: "b",
      draft: true,
    });

    expect(pull).toEqual({ number: 13, url: null });
  });

  it("reports which account the token belongs to", async () => {
    const { github } = client({
      "GET /user": () => json({ login: "octocat", email: "kept@out.example" }),
    });

    expect(await github.viewer()).toEqual({ login: "octocat" });
  });

  it("returns a merged PR without reading its checks", async () => {
    const { github, calls } = client({
      "GET /repos/acme/demo/pulls/12": () =>
        json({ state: "closed", merged: true, head: { sha: "abc123" } }),
    });

    expect(
      await github.getPullStatus({ remoteUrl: REMOTE, number: 12 }),
    ).toMatchObject({
      state: "closed",
      merged: true,
    });
    expect(calls).toHaveLength(1);
  });

  it("fails clearly without a token, on a rate limit and on a rejected token", async () => {
    const noToken = client({}, null);
    await expect(
      noToken.github.findPull({ remoteUrl: REMOTE, head: "hands/abc" }),
    ).rejects.toMatchObject({ code: "github_token_missing" });
    expect(noToken.fetchImpl).not.toHaveBeenCalled();

    const limited = client({
      "GET /repos/acme/demo/pulls/1": () =>
        new Response("{}", {
          status: 403,
          headers: {
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1800000000",
          },
        }),
      "GET /repos/acme/demo/pulls/2": () => new Response("{}", { status: 401 }),
    });
    await expect(
      limited.github.getPullStatus({ remoteUrl: REMOTE, number: 1 }),
    ).rejects.toMatchObject({ code: "github_rate_limited" });
    const rejected = limited.github.getPullStatus({
      remoteUrl: REMOTE,
      number: 2,
    });
    await expect(rejected).rejects.toMatchObject({
      code: "github_token_invalid",
    });
    await expect(rejected).rejects.not.toThrow(/t0k/);
  });
});
