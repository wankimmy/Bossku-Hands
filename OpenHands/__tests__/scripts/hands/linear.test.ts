// @vitest-environment node
import { describe, expect, it } from "vitest";

import { createLinearClient } from "../../../scripts/hands/linear.mjs";

type Call = {
  url: string;
  init: RequestInit & { headers: Record<string, string> };
};

function fakeFetch(responses: Array<{ status?: number; body: unknown }>) {
  const calls: Call[] = [];
  const fetchImpl = async (url: string, init: Call["init"]) => {
    calls.push({ url, init });
    const next = responses.shift() ?? { body: { data: {} } };
    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetchImpl, calls };
}

const client = (
  fake: ReturnType<typeof fakeFetch>,
  key: string | null = "lin_api_test",
) =>
  createLinearClient({
    getApiKey: () => key,
    fetchImpl: fake.fetchImpl as never,
  });

const issueNode = {
  id: "issue-1",
  identifier: "ENG-12",
  title: "Fix login",
  description: "Login fails on Safari",
  url: "https://linear.app/acme/issue/ENG-12",
  priority: 2,
  updatedAt: "2026-11-20T00:00:00.000Z",
  state: { id: "st-todo", name: "Todo", type: "unstarted" },
  team: { id: "team-1", key: "ENG", name: "Engineering" },
};

describe("Linear client", () => {
  it("drops issue links that are not https://linear.app", async () => {
    const fake = fakeFetch([
      {
        body: {
          data: {
            viewer: {
              assignedIssues: {
                nodes: [{ ...issueNode, url: "javascript:alert(1)" }],
              },
            },
          },
        },
      },
    ]);

    const [issue] = await client(fake).listAssignedIssues();

    expect(issue.url).toBeNull();
  });

  it("lists the viewer's open assigned issues with the API key as auth", async () => {
    const fake = fakeFetch([
      {
        body: { data: { viewer: { assignedIssues: { nodes: [issueNode] } } } },
      },
    ]);

    const issues = await client(fake).listAssignedIssues();

    expect(issues).toEqual([
      {
        id: "issue-1",
        identifier: "ENG-12",
        title: "Fix login",
        description: "Login fails on Safari",
        url: "https://linear.app/acme/issue/ENG-12",
        priority: 2,
        updatedAt: "2026-11-20T00:00:00.000Z",
        state: { id: "st-todo", name: "Todo", type: "unstarted" },
        team: { id: "team-1", key: "ENG", name: "Engineering" },
      },
    ]);
    expect(fake.calls[0].url).toBe("https://api.linear.app/graphql");
    expect(fake.calls[0].init.headers.Authorization).toBe("lin_api_test");
    const body = JSON.parse(String(fake.calls[0].init.body));
    expect(body.query).toMatch(/assignedIssues/);
    expect(body.query).toMatch(/completed/);
  });

  it("moves an issue to a workflow state", async () => {
    const fake = fakeFetch([
      {
        body: {
          data: {
            issueUpdate: {
              success: true,
              issue: {
                id: "issue-1",
                state: { id: "st-done", name: "Done", type: "completed" },
              },
            },
          },
        },
      },
    ]);

    const result = await client(fake).moveIssue("issue-1", "st-done");

    expect(result).toEqual({ id: "st-done", name: "Done", type: "completed" });
    const body = JSON.parse(String(fake.calls[0].init.body));
    expect(body.variables).toEqual({ id: "issue-1", stateId: "st-done" });
  });

  it("reads a team's workflow states", async () => {
    const fake = fakeFetch([
      {
        body: {
          data: {
            team: {
              states: {
                nodes: [
                  {
                    id: "st-done",
                    name: "Done",
                    type: "completed",
                    position: 3,
                  },
                  {
                    id: "st-todo",
                    name: "Todo",
                    type: "unstarted",
                    position: 1,
                  },
                ],
              },
            },
          },
        },
      },
    ]);

    expect(await client(fake).teamStates("team-1")).toEqual([
      { id: "st-todo", name: "Todo", type: "unstarted" },
      { id: "st-done", name: "Done", type: "completed" },
    ]);
  });

  it("fails clearly without an API key and never calls Linear", async () => {
    const fake = fakeFetch([]);
    await expect(client(fake, null).listAssignedIssues()).rejects.toMatchObject(
      {
        code: "linear_key_missing",
      },
    );
    expect(fake.calls).toHaveLength(0);
  });

  it("maps auth and rate-limit failures to codes without leaking the key", async () => {
    const invalid = fakeFetch([
      {
        status: 400,
        body: {
          errors: [
            {
              message: "Authentication required",
              extensions: { code: "AUTHENTICATION_ERROR" },
            },
          ],
        },
      },
    ]);
    const error = await client(invalid)
      .viewer()
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "linear_key_invalid" });
    expect(String((error as Error).message)).not.toContain("lin_api_test");

    const limited = fakeFetch([
      {
        status: 400,
        body: {
          errors: [
            {
              message: "Rate limit exceeded",
              extensions: { code: "RATELIMITED" },
            },
          ],
        },
      },
    ]);
    await expect(client(limited).viewer()).rejects.toMatchObject({
      code: "linear_rate_limited",
    });

    const broken = fakeFetch([{ status: 500, body: { error: "boom" } }]);
    await expect(client(broken).viewer()).rejects.toMatchObject({
      code: "linear_request_failed",
    });
  });
});
