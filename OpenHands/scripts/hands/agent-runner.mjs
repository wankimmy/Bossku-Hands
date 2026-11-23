/**
 * Runs one Hands agent stage as an Agent Server conversation.
 *
 * The conversation is started by `agent_profile_id`, so the Agent Server
 * resolves the agent and its LLM credentials itself: no model key ever passes
 * through Hands. The workspace is the session's own git worktree, never the
 * user's checkout. Aborting the stage interrupts the conversation.
 *
 * Every stage runs under the AlwaysConfirm policy: each batch of actions
 * waits until Hands checks it with the command guard, then accepts it or
 * rejects it with the reason and lets the agent carry on.
 */

import { ConversationClient as DefaultConversationClient } from "@openhands/typescript-client/clients";

import { checkAction } from "./command-guard.mjs";

// Short, because every action batch waits for the next poll to be confirmed.
const DEFAULT_POLL_MS = 1000;
const DEFAULT_TIMEOUT_MS = 60 * 60_000;
const DEFAULT_MAX_ITERATIONS = 150;
const DEFAULT_MAX_BLOCKED = 20;
const MAX_ACTION_TEXT = 300;
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

const runnerError = (code, message) =>
  Object.assign(new Error(message ?? code), { code });

function defaultSleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");

/** The agent's final words: its FinishAction message, else its last message. */
function finalOutput(events) {
  for (const event of events) {
    if (event?.action?.kind === "FinishAction" && event.action.message) {
      return String(event.action.message);
    }
  }
  for (const event of events) {
    if (event?.kind === "MessageEvent" && event.source === "agent") {
      const text = textOf(event.llm_message?.content);
      if (text) return text;
    }
  }
  return "";
}

/**
 * The waiting batch: agent actions newer than the latest observation, read
 * page by page (newest first). Null when the batch is too large to read.
 */
async function waitingBatch(client, id) {
  const events = [];
  let pageId;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await client.searchEvents(id, {
      sort_order: "TIMESTAMP_DESC",
      limit: PAGE_SIZE,
      ...(pageId ? { page_id: pageId } : {}),
    });
    const items = result?.items ?? [];
    const boundary = items.findIndex(
      (event) =>
        event?.action_id ||
        (event?.kind === "MessageEvent" && event?.source === "user"),
    );
    if (boundary >= 0) {
      events.push(...items.slice(0, boundary + 1));
      return pendingActions(events);
    }
    events.push(...items);
    pageId = result?.next_page_id;
    if (!pageId) return pendingActions(events);
  }
  return null;
}

/** Agent actions still waiting for an observation, newest first. */
function pendingActions(events) {
  const observed = new Set();
  const failedCalls = new Set();
  for (const event of events) {
    if (event?.action_id) observed.add(event.action_id);
    if (event?.kind === "AgentErrorEvent" && event.tool_call_id) {
      failedCalls.add(event.tool_call_id);
    }
  }
  return events.filter(
    (event) =>
      event?.kind === "ActionEvent" &&
      !observed.has(event.id) &&
      !failedCalls.has(event.tool_call_id),
  );
}

/** A short, human-readable form of an action for the session timeline. */
function describeAction(event) {
  const action = event?.action ?? {};
  const text =
    action.command && action.kind === "TerminalAction"
      ? action.command
      : [
          action.kind,
          action.path ??
            action.file_path ??
            action.dir_path ??
            event?.tool_name,
        ]
          .filter(Boolean)
          .join(" ");
  return String(text).slice(0, MAX_ACTION_TEXT);
}

/**
 * @param {{
 *   host: string,
 *   apiKey?: string,
 *   ConversationClient?: typeof DefaultConversationClient,
 *   pollMs?: number,
 *   timeoutMs?: number,
 *   maxIterations?: number,
 *   maxBlocked?: number,
 *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
 *   now?: () => number,
 * }} options
 */
export function createAgentServerRunner({
  host,
  apiKey,
  ConversationClient = DefaultConversationClient,
  pollMs = DEFAULT_POLL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxIterations = DEFAULT_MAX_ITERATIONS,
  maxBlocked = DEFAULT_MAX_BLOCKED,
  sleep = defaultSleep,
  now = () => Date.now(),
}) {
  return {
    /** Deletes finished stage conversations; errors are ignored. */
    async release(conversationIds) {
      const client = new ConversationClient({ host, apiKey, timeout: 60_000 });
      await Promise.all(
        conversationIds.map((id) =>
          client.deleteConversation(id).catch(() => {}),
        ),
      );
    },

    /**
     * @param {{ role: string, mode?: string, profileId: string | null, sessionId: string, cwd: string, prompt: string, signal?: AbortSignal, onConversation?: (id: string) => void }} call
     */
    async run({
      role,
      mode,
      profileId,
      sessionId,
      cwd,
      prompt,
      signal,
      onConversation,
    }) {
      // Only the coder writes, and not when it is only suggesting a CI fix.
      const readOnly = role !== "coder" || mode === "suggest";
      if (!profileId) {
        throw runnerError(
          "role_profile_missing",
          `Choose an agent profile for the ${role} role in Settings > Hands workflow`,
        );
      }
      const client = new ConversationClient({ host, apiKey, timeout: 60_000 });
      const conversation = await client.createConversation({
        agent_profile_id: profileId,
        workspace: { kind: "LocalWorkspace", working_dir: cwd },
        initial_message: {
          role: "user",
          content: [{ type: "text", text: prompt }],
          run: true,
        },
        confirmation_policy: { kind: "AlwaysConfirm" },
        max_iterations: maxIterations,
        stuck_detection: true,
        autotitle: false,
        worktree: false,
        tags: { handssession: sessionId, handsrole: role },
      });
      const id = conversation.id;
      // Reported before anything can fail, so the caller can release it.
      onConversation?.(id);
      // Aborted while the conversation was being created: stop it now, since
      // the abort listener below did not exist yet.
      if (signal?.aborted) {
        client.interruptConversation(id).catch(() => {});
        throw signal.reason;
      }

      const interrupt = () => {
        client.interruptConversation(id).catch(() => {});
      };
      signal?.addEventListener("abort", interrupt, { once: true });
      const blocked = [];

      /** Checks the waiting batch; accepts it or rejects it with reasons. */
      const reviewPending = async () => {
        const batch = await waitingBatch(client, id);
        const judged = (batch ?? []).map((event) => ({
          action: describeAction(event),
          verdict: checkAction(event, { worktreeDir: cwd, readOnly }),
        }));
        const refusals =
          batch === null
            ? [
                {
                  action: "a very large batch of actions",
                  reason:
                    "too many actions at once to check; send fewer at a time.",
                },
              ]
            : judged
                .filter(({ verdict }) => !verdict.allow)
                .map(({ action, verdict }) => ({
                  action,
                  reason: verdict.reason,
                }));
        // A refusal rejects the whole batch: name the allowed actions too.
        const notRun = judged
          .filter(({ verdict }) => verdict.allow)
          .map(({ action }) => action);
        if (refusals.length === 0) {
          await client.respondToConfirmation(id, { accept: true });
          return;
        }
        blocked.push(...refusals);
        if (blocked.length > maxBlocked) {
          interrupt();
          throw runnerError(
            "agent_guard_blocked",
            `The ${role} agent kept trying commands Hands does not allow`,
          );
        }
        await client.respondToConfirmation(id, {
          accept: false,
          reason: [
            ...refusals.map(
              ({ action, reason }) =>
                `Blocked by Bossku Hands: ${action}: ${reason}`,
            ),
            ...(notRun.length > 0
              ? [
                  `Not run because the batch was refused; send them again separately: ${notRun.join("; ")}`,
                ]
              : []),
          ].join("\n"),
        });
        // A rejection leaves the conversation idle; let the agent try again.
        await client.runConversation(id);
      };

      try {
        const deadline = now() + timeoutMs;
        for (;;) {
          await sleep(pollMs, signal);
          const info = await client.getConversation(id);
          const status = info?.execution_status;
          if (status === "finished") break;
          if (status === "error" || status === "stuck") {
            throw runnerError(
              `agent_${status}`,
              `The ${role} agent stopped: ${status}`,
            );
          }
          if (status === "waiting_for_confirmation") {
            await reviewPending();
            continue;
          }
          if (status === "paused") {
            throw runnerError("agent_paused", `The ${role} agent is ${status}`);
          }
          if (now() > deadline) {
            interrupt();
            throw runnerError(
              "agent_timeout",
              `The ${role} agent ran too long`,
            );
          }
        }
        const page = await client.searchEvents(id, {
          sort_order: "TIMESTAMP_DESC",
          limit: 50,
        });
        return {
          output: finalOutput(page?.items ?? []),
          conversationId: id,
          blocked,
        };
      } finally {
        signal?.removeEventListener("abort", interrupt);
      }
    },
  };
}
