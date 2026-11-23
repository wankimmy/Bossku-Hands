/**
 * The small part of the Linear GraphQL API that Hands uses: the viewer's open
 * assigned issues, a team's workflow states, and moving an issue to a state.
 * The API key comes from `getApiKey`, is sent only to Linear, and is never
 * written to an error message.
 */

const DEFAULT_API_URL = "https://api.linear.app/graphql";
const REQUEST_TIMEOUT_MS = 20_000;

const linearError = (code, message, extra = {}) =>
  Object.assign(new Error(message ?? code), { code, ...extra });

const ISSUE_FIELDS = `
  id identifier title description url priority updatedAt
  state { id name type }
  team { id key name }
`;

/** The issue link, only when it is an https://linear.app address. */
const linearUrl = (value) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && url.hostname === "linear.app"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
};

const pickIssue = (node) => ({
  id: node.id,
  identifier: node.identifier,
  title: node.title,
  description: node.description ?? "",
  url: linearUrl(node.url),
  priority: node.priority ?? 0,
  updatedAt: node.updatedAt,
  state: node.state
    ? { id: node.state.id, name: node.state.name, type: node.state.type }
    : null,
  team: node.team
    ? { id: node.team.id, key: node.team.key, name: node.team.name }
    : null,
});

/**
 * @param {{
 *   getApiKey: () => string | null | undefined | Promise<string | null | undefined>,
 *   fetchImpl?: typeof fetch,
 *   apiUrl?: string,
 * }} options
 */
export function createLinearClient({
  getApiKey,
  fetchImpl = fetch,
  apiUrl = DEFAULT_API_URL,
}) {
  async function graphql(query, variables = {}) {
    const key = await getApiKey();
    if (!key) {
      throw linearError(
        "linear_key_missing",
        "Set BOSSKU_HANDS_LINEAR_API_KEY or LINEAR_API_KEY to use Linear",
      );
    }
    let response;
    try {
      response = await fetchImpl(apiUrl, {
        method: "POST",
        headers: {
          Authorization: key,
          "Content-Type": "application/json",
          "User-Agent": "bossku-hands",
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw linearError("linear_request_failed", "Linear could not be reached");
    }
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const errors = Array.isArray(payload?.errors) ? payload.errors : [];
    const codes = errors.map((error) => error?.extensions?.code);
    if (response.status === 401 || codes.includes("AUTHENTICATION_ERROR")) {
      throw linearError("linear_key_invalid", "Linear rejected the API key", {
        status: response.status,
      });
    }
    if (response.status === 429 || codes.includes("RATELIMITED")) {
      throw linearError("linear_rate_limited", "Linear rate limit reached", {
        status: response.status,
      });
    }
    if (!response.ok || errors.length > 0 || !payload?.data) {
      throw linearError(
        "linear_request_failed",
        `Linear returned ${response.status}`,
        { status: response.status },
      );
    }
    return payload.data;
  }

  return {
    /** The account the key belongs to (name only; no email is kept). */
    async viewer() {
      const data = await graphql("query { viewer { id name } }");
      return { id: data.viewer.id, name: data.viewer.name };
    },

    /** Issues assigned to the viewer that are not completed or canceled. */
    async listAssignedIssues({ first = 50 } = {}) {
      const data = await graphql(
        `query HandsInbox($first: Int!) {
          viewer {
            assignedIssues(
              first: $first
              orderBy: updatedAt
              filter: { state: { type: { nin: ["completed", "canceled"] } } }
            ) { nodes { ${ISSUE_FIELDS} } }
          }
        }`,
        { first },
      );
      return (data.viewer?.assignedIssues?.nodes ?? []).map(pickIssue);
    },

    async getIssue(id) {
      const data = await graphql(
        `query HandsIssue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`,
        { id },
      );
      if (!data.issue) {
        throw linearError("linear_issue_not_found", "Linear issue not found");
      }
      return pickIssue(data.issue);
    },

    /** A team's workflow states, in board order. */
    async teamStates(teamId) {
      const data = await graphql(
        `
          query HandsTeamStates($id: String!) {
            team(id: $id) {
              states {
                nodes {
                  id
                  name
                  type
                  position
                }
              }
            }
          }
        `,
        { id: teamId },
      );
      return [...(data.team?.states?.nodes ?? [])]
        .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
        .map(({ id, name, type }) => ({ id, name, type }));
    },

    /** Moves an issue to a workflow state; resolves to the new state. */
    async moveIssue(issueId, stateId) {
      const data = await graphql(
        `
          mutation HandsMoveIssue($id: String!, $stateId: String!) {
            issueUpdate(id: $id, input: { stateId: $stateId }) {
              success
              issue {
                id
                state {
                  id
                  name
                  type
                }
              }
            }
          }
        `,
        { id: issueId, stateId },
      );
      if (!data.issueUpdate?.success) {
        throw linearError(
          "linear_request_failed",
          "Linear did not move the issue",
        );
      }
      const state = data.issueUpdate.issue.state;
      return { id: state.id, name: state.name, type: state.type };
    },
  };
}
