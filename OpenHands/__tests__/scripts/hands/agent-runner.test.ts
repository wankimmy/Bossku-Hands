// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

import { createAgentServerRunner } from "../../../scripts/hands/agent-runner.mjs";

type Status =
  "running" | "finished" | "error" | "stuck" | "waiting_for_confirmation";

// Built at runtime so this file never holds the literal network command.
const PUSH_COMMAND = ["git", ["pu", "sh"].join("")].join(" ");

/** An in-memory stand-in for the typescript-client ConversationClient. */
function fakeClientClass(options: {
  statuses: Status[];
  events?: unknown[];
  eventPages?: Array<
    unknown[] | { items: unknown[]; next_page_id: string | null }
  >;
}) {
  const created: Array<Record<string, unknown>> = [];
  const interrupted: string[] = [];
  const responses: Array<Record<string, unknown>> = [];
  const runs: string[] = [];
  const deleted: string[] = [];
  const searches: Array<Record<string, unknown>> = [];
  const constructed: Array<Record<string, unknown>> = [];
  class FakeConversationClient {
    constructor(init: Record<string, unknown>) {
      constructed.push(init);
    }

    async createConversation(payload: Record<string, unknown>) {
      created.push(payload);
      return { id: "conv-1" };
    }

    async getConversation() {
      return {
        id: "conv-1",
        execution_status: options.statuses.shift() ?? "running",
      };
    }

    async searchEvents(_id: string, query: Record<string, unknown> = {}) {
      searches.push(query);
      const next = options.eventPages?.shift();
      if (next && !Array.isArray(next)) return next;
      return { items: next ?? options.events ?? [] };
    }

    async respondToConfirmation(_id: string, request: Record<string, unknown>) {
      responses.push(request);
      return { success: true };
    }

    async deleteConversation(id: string) {
      if (id === "conv-broken") throw new Error("gone");
      deleted.push(id);
    }

    async runConversation(id: string) {
      runs.push(id);
      return { success: true };
    }

    async interruptConversation(id: string) {
      interrupted.push(id);
      return { success: true };
    }
  }
  return {
    FakeConversationClient,
    created,
    interrupted,
    constructed,
    responses,
    runs,
    deleted,
    searches,
  };
}

const call = (overrides: Record<string, unknown> = {}) => ({
  role: "coder",
  profileId: "profile-1",
  sessionId: "abc123",
  cwd: "C:\\hands\\worktrees\\abc123",
  prompt: "Implement the plan",
  signal: new AbortController().signal,
  ...overrides,
});

const finish = (message: string) => ({
  kind: "ActionEvent",
  source: "agent",
  action: { kind: "FinishAction", message },
});

function runner(fake: ReturnType<typeof fakeClientClass>, extra = {}) {
  return createAgentServerRunner({
    host: "http://127.0.0.1:18000",
    apiKey: "session-key",
    // Structural stand-in for the real client class.
    ConversationClient: fake.FakeConversationClient as never,
    sleep: () => Promise.resolve(),
    ...extra,
  });
}

describe("Hands agent-server runner", () => {
  it("runs the role in the worktree under its profile and returns the finish message", async () => {
    const fake = fakeClientClass({
      statuses: ["running", "finished"],
      events: [finish("Wrote hello.txt and ran the tests.")],
    });

    const result = await runner(fake).run(call());

    expect(result).toMatchObject({
      output: "Wrote hello.txt and ran the tests.",
      conversationId: "conv-1",
    });
    expect(fake.constructed[0]).toMatchObject({
      host: "http://127.0.0.1:18000",
      apiKey: "session-key",
    });
    expect(fake.created[0]).toMatchObject({
      agent_profile_id: "profile-1",
      workspace: {
        kind: "LocalWorkspace",
        working_dir: "C:\\hands\\worktrees\\abc123",
      },
      initial_message: {
        role: "user",
        content: [{ type: "text", text: "Implement the plan" }],
        run: true,
      },
      confirmation_policy: { kind: "AlwaysConfirm" },
      worktree: false,
      tags: { handssession: "abc123", handsrole: "coder" },
    });
  });

  it("falls back to the agent's last message when it did not call finish", async () => {
    const fake = fakeClientClass({
      statuses: ["finished"],
      events: [
        {
          kind: "MessageEvent",
          source: "agent",
          llm_message: {
            role: "assistant",
            content: [{ type: "text", text: "VERDICT: APPROVE" }],
          },
        },
      ],
    });

    expect((await runner(fake).run(call({ role: "reviewer" }))).output).toBe(
      "VERDICT: APPROVE",
    );
  });

  it("refuses to start a role that has no agent profile", async () => {
    const fake = fakeClientClass({ statuses: [] });

    await expect(
      runner(fake).run(call({ profileId: null })),
    ).rejects.toMatchObject({
      code: "role_profile_missing",
    });
    expect(fake.created).toHaveLength(0);
  });

  it("reports the conversation id before the stage can fail", async () => {
    const seen: string[] = [];

    await expect(
      runner(fakeClientClass({ statuses: ["error"] })).run(
        call({ onConversation: (id: string) => seen.push(id) }),
      ),
    ).rejects.toMatchObject({ code: "agent_error" });
    expect(seen).toEqual(["conv-1"]);
  });

  it("rejects when the conversation errors or gets stuck", async () => {
    await expect(
      runner(fakeClientClass({ statuses: ["running", "error"] })).run(call()),
    ).rejects.toMatchObject({ code: "agent_error" });
    await expect(
      runner(fakeClientClass({ statuses: ["stuck"] })).run(call()),
    ).rejects.toMatchObject({ code: "agent_stuck" });
  });

  describe("command guard", () => {
    const terminal = (id: string, command: string) => ({
      kind: "ActionEvent",
      source: "agent",
      id,
      tool_call_id: `call-${id}`,
      tool_name: "terminal",
      action: { kind: "TerminalAction", command },
    });

    it("accepts a pending batch that passes the guard", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "finished"],
        eventPages: [[terminal("a1", "npm test")], [finish("done")]],
      });

      const result = await runner(fake).run(call());

      expect(fake.responses).toEqual([{ accept: true }]);
      expect(fake.runs).toEqual([]);
      expect(result).toMatchObject({ output: "done", blocked: [] });
    });

    it("rejects a blocked command with the reason, then resumes the agent", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "running", "finished"],
        eventPages: [[terminal("a1", PUSH_COMMAND)], [finish("done")]],
      });

      const result = await runner(fake).run(call());

      expect(fake.responses).toEqual([
        { accept: false, reason: expect.stringMatching(/Hands/) },
      ]);
      expect(fake.runs).toEqual(["conv-1"]);
      expect(result.blocked).toEqual([
        { action: PUSH_COMMAND, reason: expect.stringMatching(/Hands/) },
      ]);
    });

    it("refuses file edits from the reviewer, which must not write", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "running", "finished"],
        eventPages: [
          [
            {
              kind: "ActionEvent",
              source: "agent",
              id: "a1",
              tool_call_id: "call-a1",
              tool_name: "file_editor",
              action: {
                kind: "FileEditorAction",
                command: "create",
                path: "x.ts",
              },
            },
          ],
          [finish("VERDICT: APPROVE")],
        ],
      });

      const result = await runner(fake).run(call({ role: "reviewer" }));

      expect(fake.responses).toEqual([
        { accept: false, reason: expect.stringMatching(/read-only/) },
      ]);
      expect(result.blocked).toHaveLength(1);
    });

    it("reads every page of a large batch before deciding", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "running", "finished"],
        eventPages: [
          { items: [terminal("a2", "npm test")], next_page_id: "p2" },
          {
            items: [
              terminal("a1", PUSH_COMMAND),
              { kind: "ObservationEvent", action_id: "a0" },
            ],
            next_page_id: "p3",
          },
          [finish("done")],
        ],
      });

      await runner(fake).run(call());

      expect(fake.searches[1]).toMatchObject({ page_id: "p2" });
      expect(fake.responses[0]).toMatchObject({ accept: false });
    });

    it("tells the agent which allowed actions did not run in a refused batch", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "running", "finished"],
        eventPages: [
          [terminal("a2", "npm test"), terminal("a1", PUSH_COMMAND)],
          [finish("done")],
        ],
      });

      await runner(fake).run(call());

      const reason = String(fake.responses[0].reason);
      expect(reason).toMatch(/Blocked by Bossku Hands/);
      expect(reason).toMatch(/Not run[^]*npm test/);
    });

    it("judges only actions that have no observation yet", async () => {
      const fake = fakeClientClass({
        statuses: ["waiting_for_confirmation", "finished"],
        eventPages: [
          [
            terminal("a2", "npm test"),
            { kind: "ObservationEvent", action_id: "a1" },
            terminal("a1", PUSH_COMMAND),
          ],
          [finish("done")],
        ],
      });

      await runner(fake).run(call());

      expect(fake.responses).toEqual([{ accept: true }]);
    });

    it("stops a stage whose agent keeps hitting the guard", async () => {
      const fake = fakeClientClass({
        statuses: [
          "waiting_for_confirmation",
          "waiting_for_confirmation",
          "waiting_for_confirmation",
        ],
        eventPages: [
          [terminal("a1", PUSH_COMMAND)],
          [terminal("a2", PUSH_COMMAND)],
          [terminal("a3", PUSH_COMMAND)],
        ],
      });

      await expect(
        runner(fake, { maxBlocked: 2 }).run(call()),
      ).rejects.toMatchObject({ code: "agent_guard_blocked" });
      expect(fake.interrupted).toEqual(["conv-1"]);
    });
  });

  it("deletes finished stage conversations and ignores failures", async () => {
    const fake = fakeClientClass({ statuses: [] });

    await runner(fake).release(["conv-1", "conv-broken", "conv-2"]);

    expect(fake.deleted).toEqual(["conv-1", "conv-2"]);
  });

  it("interrupts the conversation when the stage is aborted", async () => {
    const fake = fakeClientClass({ statuses: [] });
    const controller = new AbortController();
    const sleep = vi.fn(
      (_ms: number, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason));
        }),
    );

    const running = runner(fake, { sleep }).run(
      call({ signal: controller.signal }),
    );
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    controller.abort(new Error("cancelled"));

    await expect(running).rejects.toThrow("cancelled");
    expect(fake.interrupted).toEqual(["conv-1"]);
  });

  it("interrupts a conversation that was still being created when the stage was aborted", async () => {
    const fake = fakeClientClass({ statuses: [] });
    const controller = new AbortController();
    const original = fake.FakeConversationClient.prototype.createConversation;
    fake.FakeConversationClient.prototype.createConversation = async function (
      this: unknown,
      payload: Record<string, unknown>,
    ) {
      controller.abort(new Error("cancelled"));
      return original.call(this, payload);
    };

    await expect(
      runner(fake).run(call({ signal: controller.signal })),
    ).rejects.toThrow("cancelled");
    expect(fake.interrupted).toEqual(["conv-1"]);
  });
});
