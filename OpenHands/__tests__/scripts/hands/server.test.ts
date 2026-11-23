// @vitest-environment node
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createHandsServer,
  resolveGithubApiBase,
} from "../../../scripts/hands/server.mjs";

const KEY = "session-key";
const servers: Array<{ close: () => void }> = [];

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

const handsError = (code: string, extra = {}) =>
  Object.assign(new Error(code), { code, ...extra });

function stubOrchestrator() {
  const session = { id: "abc123", state: "PLANNING" };
  return {
    listSessions: vi.fn(() => [session]),
    getSession: vi.fn((id: string) => (id === "abc123" ? session : null)),
    startSession: vi.fn(async () => session),
    approve: vi.fn(async () => session),
    cancel: vi.fn(async () => session),
    resume: vi.fn(async () => session),
    retry: vi.fn(async () => session),
    refresh: vi.fn(() => session),
    getSettings: vi.fn(() => ({ autoFixCi: "local" })),
    updateSettings: vi.fn((patch: object) => ({
      autoFixCi: "local",
      ...patch,
    })),
    connections: vi.fn(async () => ({
      github: { ok: true, account: "octocat" },
      linear: { ok: false, error: "linear_key_missing" },
    })),
    linearInbox: vi.fn(async () => ({ issues: [] })),
    startFromLinear: vi.fn(async () => session),
    linearTeamStates: vi.fn(async () => ({ states: [] })),
    syncLinear: vi.fn(async () => session),
    sessionDiff: vi.fn(async () => ({ files: [], patch: "" })),
  };
}

const stubBrowser = () => ({
  status: vi.fn(async () => ({ installed: false })),
  install: vi.fn(async () => ({ installed: true, added: true })),
});

async function start(
  orchestrator = stubOrchestrator(),
  browser = stubBrowser(),
) {
  const server = createHandsServer({
    orchestrator: orchestrator as never,
    sessionApiKey: KEY,
    browser: browser as never,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  const { port } = server.address() as AddressInfo;
  return { orchestrator, port };
}

/** Loosely typed JSON body; each test asserts the fields it needs. */
type ResponseBody = Record<string, unknown> & {
  error?: Record<string, unknown>;
  session?: Record<string, unknown>;
};

function call(
  port: number,
  method: string,
  path: string,
  options: { body?: string; headers?: Record<string, string> } = {},
) {
  return new Promise<{ status: number; body: ResponseBody }>(
    (resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          method,
          path,
          headers: {
            "x-session-api-key": KEY,
            "content-type": "application/json",
            ...options.headers,
          },
        },
        (res) => {
          let text = "";
          res.on("data", (chunk) => {
            text += chunk;
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode!,
              body: text ? JSON.parse(text) : null,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(options.body);
    },
  );
}

describe("Hands local API", () => {
  it("refuses a missing session key and a foreign Host header", async () => {
    const { port, orchestrator } = await start();

    const anonymous = await call(port, "GET", "/api/hands/sessions", {
      headers: { "x-session-api-key": "" },
    });
    const rebound = await call(port, "GET", "/api/hands/sessions", {
      headers: { host: "evil.example:8100" },
    });

    expect(anonymous).toMatchObject({
      status: 401,
      body: { error: { code: "unauthorized" } },
    });
    expect(rebound).toMatchObject({
      status: 403,
      body: { error: { code: "forbidden_host" } },
    });
    expect(orchestrator.listSessions).not.toHaveBeenCalled();
  });

  it("lists, starts and reads sessions", async () => {
    const { port, orchestrator } = await start();

    expect(await call(port, "GET", "/api/hands/sessions")).toMatchObject({
      status: 200,
      body: { sessions: [{ id: "abc123" }] },
    });
    const started = await call(port, "POST", "/api/hands/sessions", {
      body: JSON.stringify({
        task: "Add a hello file",
        repoDir: "C:\\code\\demo",
      }),
    });
    expect(started).toMatchObject({ status: 201, body: { id: "abc123" } });
    expect(orchestrator.startSession).toHaveBeenCalledWith({
      source: "chat",
      task: "Add a hello file",
      repoDir: "C:\\code\\demo",
      baseBranch: undefined,
    });
    expect((await call(port, "GET", "/api/hands/sessions/nope")).status).toBe(
      404,
    );
  });

  it("maps orchestrator refusals to HTTP status codes", async () => {
    const orchestrator = stubOrchestrator();
    orchestrator.startSession.mockRejectedValueOnce(
      handsError("not_a_git_repository"),
    );
    orchestrator.approve.mockResolvedValueOnce({
      id: "abc123",
      state: "AWAITING_APPROVAL",
      error: { code: "approval_gate_mismatch", expected: "approve_plan" },
    } as never);
    orchestrator.updateSettings.mockImplementationOnce(() => {
      throw handsError("invalid_settings", { field: "ciRepairBudget" });
    });
    const { port } = await start(orchestrator);

    const badRepo = await call(port, "POST", "/api/hands/sessions", {
      body: JSON.stringify({ task: "x", repoDir: "C:\\nope" }),
    });
    const refused = await call(
      port,
      "POST",
      "/api/hands/sessions/abc123/approve",
      {
        body: JSON.stringify({ gate: "push_fix" }),
      },
    );
    const invalid = await call(port, "PUT", "/api/hands/settings", {
      body: JSON.stringify({ ciRepairBudget: 99 }),
    });

    expect(badRepo).toMatchObject({
      status: 400,
      body: { error: { code: "not_a_git_repository" } },
    });
    expect(refused).toMatchObject({
      status: 409,
      body: {
        error: { code: "approval_gate_mismatch", expected: "approve_plan" },
      },
    });
    expect(orchestrator.approve).toHaveBeenCalledWith("abc123", "push_fix");
    expect(invalid).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_settings", field: "ciRepairBudget" } },
    });
  });

  it("routes the session actions and settings", async () => {
    const { port, orchestrator } = await start();

    for (const action of ["cancel", "resume", "retry", "refresh"] as const) {
      expect(
        (await call(port, "POST", `/api/hands/sessions/abc123/${action}`))
          .status,
      ).toBe(200);
      expect(orchestrator[action]).toHaveBeenCalledWith("abc123");
    }
    expect(await call(port, "GET", "/api/hands/settings")).toMatchObject({
      status: 200,
      body: { autoFixCi: "local" },
    });
    expect(
      await call(port, "PUT", "/api/hands/settings", {
        body: JSON.stringify({ autoFixCi: "off" }),
      }),
    ).toMatchObject({ status: 200, body: { autoFixCi: "off" } });
  });

  it("rejects malformed and oversized bodies", async () => {
    const { port, orchestrator } = await start();

    const malformed = await call(port, "POST", "/api/hands/sessions", {
      body: "{nope",
    });
    const oversized = await call(port, "POST", "/api/hands/sessions", {
      body: JSON.stringify({ task: "x".repeat(200_000), repoDir: "C:\\code" }),
    }).catch(() => ({ status: 413, body: null }));

    expect(malformed).toMatchObject({
      status: 400,
      body: { error: { code: "invalid_json" } },
    });
    expect(oversized.status).toBe(413);
    expect(orchestrator.startSession).not.toHaveBeenCalled();
  });
});

describe("Hands server: Linear, connections and changes", () => {
  it("routes the Linear, connections and diff endpoints", async () => {
    const { orchestrator, port } = await start();

    expect((await call(port, "GET", "/api/hands/connections")).body).toEqual({
      github: { ok: true, account: "octocat" },
      linear: { ok: false, error: "linear_key_missing" },
    });
    expect((await call(port, "GET", "/api/hands/linear/issues")).status).toBe(
      200,
    );
    const started = await call(
      port,
      "POST",
      "/api/hands/linear/issues/issue-1/start",
      {
        body: JSON.stringify({ repoDir: "C:/work/app", task: "ignored" }),
      },
    );
    expect(started.status).toBe(201);
    expect(orchestrator.startFromLinear).toHaveBeenCalledWith("issue-1", {
      repoDir: "C:/work/app",
      baseBranch: undefined,
    });
    expect(
      (await call(port, "GET", "/api/hands/linear/teams/team-1/states")).status,
    ).toBe(200);
    expect(orchestrator.linearTeamStates).toHaveBeenCalledWith("team-1");
    expect(
      (
        await call(port, "POST", "/api/hands/sessions/abc123/linear-sync", {
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(
      (await call(port, "GET", "/api/hands/sessions/abc123/diff")).status,
    ).toBe(200);
    expect(orchestrator.sessionDiff).toHaveBeenCalledWith("abc123");
  });

  it("reports and installs the Edge browser", async () => {
    const { port } = await start();

    expect((await call(port, "GET", "/api/hands/browser")).body).toEqual({
      installed: false,
    });
    expect(
      (await call(port, "POST", "/api/hands/browser/edge", { body: "{}" }))
        .body,
    ).toEqual({ installed: true, added: true });
  });

  it("returns Linear errors with their code and the fields the UI needs", async () => {
    const orchestrator = stubOrchestrator();
    orchestrator.startFromLinear.mockRejectedValueOnce(
      handsError("linear_team_not_mapped", { teamKey: "ENG" }),
    );
    orchestrator.linearInbox.mockRejectedValueOnce(
      handsError("linear_rate_limited"),
    );
    const { port } = await start(orchestrator);

    const unmapped = await call(
      port,
      "POST",
      "/api/hands/linear/issues/issue-1/start",
      { body: "{}" },
    );
    expect(unmapped.status).toBe(409);
    expect(unmapped.body.error).toMatchObject({
      code: "linear_team_not_mapped",
      teamKey: "ENG",
    });
    expect((await call(port, "GET", "/api/hands/linear/issues")).status).toBe(
      429,
    );
  });
});

describe("resolveGithubApiBase", () => {
  it("defaults to api.github.com", () => {
    expect(resolveGithubApiBase(undefined)).toBe("https://api.github.com");
  });

  it("accepts https, or plain http on loopback only", () => {
    expect(resolveGithubApiBase("https://ghe.example.com/api/v3/")).toBe(
      "https://ghe.example.com/api/v3",
    );
    expect(resolveGithubApiBase("http://127.0.0.1:19991")).toBe(
      "http://127.0.0.1:19991",
    );
    for (const bad of [
      "http://example.com",
      "ftp://127.0.0.1",
      "https://user:pass@ghe.example.com",
      "not a url",
    ]) {
      expect(() => resolveGithubApiBase(bad), bad).toThrow(
        /BOSSKU_HANDS_GITHUB_API_URL/,
      );
    }
  });
});
