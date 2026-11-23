/**
 * Gives Hands agents a real Microsoft Edge browser through Playwright MCP.
 *
 * Hands has no in-app browser. This adds one MCP server to the Agent
 * Server's global MCP settings; agent profiles expose every global server by
 * default (`mcp_server_refs: null`). The package version is pinned. The
 * command guard allows only the `browser_*` tools from MCP servers.
 */

export const EDGE_MCP_KEY = "edge-browser";
export const PLAYWRIGHT_MCP_VERSION = "0.0.85";
export const EDGE_MCP_SERVER = Object.freeze({
  command: "npx",
  args: [
    "-y",
    `@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`,
    "--browser",
    "msedge",
  ],
  description: "Microsoft Edge for Bossku Hands agents (Playwright MCP)",
});

const REQUEST_TIMEOUT_MS = 20_000;

const setupError = (status) =>
  Object.assign(new Error(`agent server returned ${status}`), {
    code: "agent_server_request_failed",
    status,
  });

/**
 * @param {{ agentServerUrl: string, apiKey: string, fetchImpl?: typeof fetch }} options
 */
export function createEdgeBrowserSetup({
  agentServerUrl,
  apiKey,
  fetchImpl = fetch,
}) {
  async function call(method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${agentServerUrl}${path}`, {
        method,
        headers: {
          "X-Session-API-Key": apiKey,
          "Content-Type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw setupError(0);
    }
    if (!response.ok) throw setupError(response.status);
    return response.json().catch(() => ({}));
  }

  const installed = async () => {
    const settings = await call("GET", "/api/settings");
    return Boolean(settings?.agent_settings?.mcp_config?.[EDGE_MCP_KEY]);
  };

  return {
    async status() {
      return { installed: await installed() };
    },

    /** Adds the Edge MCP server unless it is already there. */
    async install() {
      if (await installed()) return { installed: true, added: false };
      await call("POST", `/api/settings/mcp/${EDGE_MCP_KEY}`, EDGE_MCP_SERVER);
      return { installed: true, added: true };
    },
  };
}
