// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import {
  EDGE_MCP_KEY,
  createEdgeBrowserSetup,
} from "../../../scripts/hands/edge-browser.mjs";

function fakeAgentServer(mcpConfig: Record<string, unknown> = {}) {
  const calls: Array<{
    method: string;
    path: string;
    body?: unknown;
    key?: string;
  }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    const { pathname } = new URL(url);
    const headers = init.headers as Record<string, string>;
    calls.push({
      method: String(init.method),
      path: pathname,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
      key: headers["X-Session-API-Key"],
    });
    if (init.method === "GET" && pathname === "/api/settings") {
      return new Response(
        JSON.stringify({ agent_settings: { mcp_config: mcpConfig } }),
        { status: 200 },
      );
    }
    if (
      init.method === "POST" &&
      pathname === `/api/settings/mcp/${EDGE_MCP_KEY}`
    ) {
      return new Response("{}", { status: 201 });
    }
    return new Response("{}", { status: 404 });
  });
  return { fetchImpl, calls };
}

const setupWith = (fake: ReturnType<typeof fakeAgentServer>) =>
  createEdgeBrowserSetup({
    agentServerUrl: "http://127.0.0.1:18000",
    apiKey: "session-key",
    fetchImpl: fake.fetchImpl as never,
  });

describe("Edge browser setup (Playwright MCP)", () => {
  it("adds a pinned Playwright MCP server that drives Microsoft Edge", async () => {
    const fake = fakeAgentServer();

    expect(await setupWith(fake).install()).toEqual({
      installed: true,
      added: true,
    });

    const post = fake.calls.find((c) => c.method === "POST")!;
    expect(post.key).toBe("session-key");
    expect(post.body).toMatchObject({
      command: "npx",
      args: [
        "-y",
        expect.stringMatching(/^@playwright\/mcp@\d+\.\d+\.\d+$/),
        "--browser",
        "msedge",
      ],
    });
  });

  it("does nothing when the Edge server is already configured", async () => {
    const fake = fakeAgentServer({ [EDGE_MCP_KEY]: { command: "npx" } });

    expect(await setupWith(fake).install()).toEqual({
      installed: true,
      added: false,
    });
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports whether Edge is configured", async () => {
    expect(await setupWith(fakeAgentServer()).status()).toEqual({
      installed: false,
    });
    expect(
      await setupWith(fakeAgentServer({ [EDGE_MCP_KEY]: {} })).status(),
    ).toEqual({ installed: true });
  });

  it("fails with a code when the agent server refuses", async () => {
    const fake = fakeAgentServer();
    fake.fetchImpl.mockImplementation(
      async () => new Response("{}", { status: 500 }),
    );

    await expect(setupWith(fake).status()).rejects.toMatchObject({
      code: "agent_server_request_failed",
    });
  });
});
