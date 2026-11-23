import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, useParamsMock } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSession } from "#/api/hands/hands-types";
import HandsSessionDetail from "#/routes/hands-session-detail";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: {
    getSession: vi.fn(),
    approve: vi.fn(),
    cancel: vi.fn(),
    resume: vi.fn(),
    retry: vi.fn(),
    refresh: vi.fn(),
    linearSync: vi.fn(),
  },
}));

const getSession = vi.mocked(handsService.getSession);
const approve = vi.mocked(handsService.approve);
const cancel = vi.mocked(handsService.cancel);
const linearSync = vi.mocked(handsService.linearSync);

const session = (overrides: Partial<HandsSession> = {}): HandsSession =>
  ({
    id: "s1",
    state: "PLANNING",
    request: { source: "ui", task: "Fix login", repoDir: "C:\\work\\demo-app" },
    repoDir: "C:\\work\\demo-app",
    baseBranch: "main",
    settings: { ciRepairBudget: 3 },
    plan: null,
    review: null,
    pendingApproval: null,
    pr: null,
    counters: { reviewRounds: 0, ciRepairRounds: 1 },
    escalation: null,
    failure: null,
    warnings: [],
    events: [],
    ...overrides,
  }) as HandsSession;

const renderDetail = () => {
  useParamsMock.mockReturnValue({ sessionId: "s1" } as never);
  return renderWithProviders(<HandsSessionDetail />);
};

describe("HandsSessionDetail route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves exactly the pending gate and shows what is approved", async () => {
    getSession.mockResolvedValue(
      session({
        state: "AWAITING_APPROVAL",
        pendingApproval: "approve_plan",
        plan: "Step one: add a toggle",
      }),
    );
    approve.mockResolvedValue(session({ state: "CODING" }));
    renderDetail();

    expect(
      await screen.findByText("Step one: add a toggle"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: I18nKey.HANDS$APPROVE_PLAN }),
    );

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith({ id: "s1", gate: "approve_plan" }),
    );
  });

  it("asks for confirmation before cancelling", async () => {
    getSession.mockResolvedValue(session({ state: "CODING" }));
    cancel.mockResolvedValue(session({ state: "CANCELLED" }));
    renderDetail();

    await userEvent.click(
      await screen.findByRole("button", { name: I18nKey.HANDS$CANCEL_SESSION }),
    );
    expect(cancel).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId("confirm-button"));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ id: "s1" }));
  });

  it.each([
    ["SUSPENDED", "hands-resume", "hands-retry"],
    ["FAILED", "hands-retry", "hands-resume"],
  ] as const)("%s shows %s but not %s", async (state, shown, hidden) => {
    getSession.mockResolvedValue(
      session({
        state,
        failure: { stage: "CODING", message: "boom" },
      }),
    );
    renderDetail();

    expect(await screen.findByTestId(shown)).toBeInTheDocument();
    expect(screen.queryByTestId(hidden)).not.toBeInTheDocument();
  });

  it("hides every action once the session is finished", async () => {
    getSession.mockResolvedValue(session({ state: "COMPLETED" }));
    renderDetail();

    await screen.findByTestId("hands-session-state");
    expect(screen.queryByTestId("hands-cancel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("hands-refresh")).not.toBeInTheDocument();
  });

  it("says a ready PR is for a human and not merged", async () => {
    getSession.mockResolvedValue(
      session({
        state: "READY_FOR_HUMAN_REVIEW",
        pr: {
          number: 9,
          url: "https://github.com/x/y/pull/9",
          head: { ref: "h", sha: "s" },
        },
      }),
    );
    renderDetail();

    expect(await screen.findByTestId("hands-ready-notice")).toHaveTextContent(
      I18nKey.HANDS$READY_FOR_HUMAN,
    );
    expect(screen.getByTestId("hands-refresh")).toBeInTheDocument();
  });

  it("explains an escalation reason as a sentence and shows a suggested fix", async () => {
    getSession.mockResolvedValue(
      session({
        state: "ESCALATED",
        escalation: {
          reason: "fix_suggested",
          detail: "Bump the timeout to 30s",
        },
      }),
    );
    renderDetail();

    const escalation = await screen.findByTestId("hands-escalation");
    expect(escalation).toHaveTextContent(
      I18nKey.HANDS$ESCALATION_FIX_SUGGESTED,
    );
    expect(screen.getByTestId("hands-escalation-detail")).toHaveTextContent(
      "Bump the timeout to 30s",
    );
  });

  it("explains each warning in its own words", async () => {
    getSession.mockResolvedValue(
      session({
        state: "WATCHING_CI",
        warnings: [
          {
            code: "secret_files_skipped",
            files: [".env"],
            at: "2026-11-23T00:00:00.000Z",
          },
          {
            code: "commands_blocked",
            role: "coder",
            files: [],
            actions: [
              {
                action: "sudo apt install jq",
                reason: "running commands as another user is not allowed.",
              },
            ],
            at: "2026-11-23T00:00:01.000Z",
          },
        ],
      }),
    );
    renderDetail();

    const warnings = await screen.findByTestId("hands-warnings");
    expect(warnings).toHaveTextContent(
      I18nKey.HANDS$WARNING_SECRET_FILES_SKIPPED,
    );
    expect(warnings).toHaveTextContent(".env");
    expect(warnings).toHaveTextContent(I18nKey.HANDS$WARNING_COMMANDS_BLOCKED);
    expect(warnings).toHaveTextContent("sudo apt install jq");
    expect(warnings).toHaveTextContent(
      "running commands as another user is not allowed.",
    );
    expect(warnings).not.toHaveTextContent(
      I18nKey.HANDS$WARNING_REVIEWER_CHANGED_FILES,
    );
  });

  it("marks the stage the session is at, what is done, and what is not started", async () => {
    getSession.mockResolvedValue(
      session({
        state: "CODING",
        plan: "Step one",
        counters: { reviewRounds: 0, ciRepairRounds: 0 },
      }),
    );
    renderDetail();

    const graph = await screen.findByRole("img", {
      name: I18nKey.HANDS$GRAPH_ARIA,
    });
    expect(graph).toBeInTheDocument();
    expect(await screen.findByTestId("hands-graph-node-plan")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(screen.getByTestId("hands-graph-node-code")).toHaveAttribute(
      "data-status",
      "current",
    );
    expect(screen.getByTestId("hands-graph-node-merged")).toHaveAttribute(
      "data-status",
      "upcoming",
    );
  });

  it("shows a readable stage list instead of the graph on a narrow screen", async () => {
    const original = window.matchMedia;
    window.matchMedia = vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia;
    try {
      getSession.mockResolvedValue(
        session({
          state: "CODING",
          counters: { reviewRounds: 0, ciRepairRounds: 0 },
        }),
      );
      renderDetail();

      const list = await screen.findByTestId("hands-stage-list");
      expect(list.tagName).toBe("OL");
      expect(screen.getByTestId("hands-stage-plan")).toHaveAttribute(
        "data-status",
        "done",
      );
      expect(screen.getByTestId("hands-stage-code")).toHaveAttribute(
        "data-status",
        "current",
      );
      expect(screen.getByTestId("hands-stage-code")).toHaveTextContent(
        I18nKey.HANDS$STAGE_CODE,
      );
      expect(screen.queryByTestId("hands-execution-graph")).toBeNull();
    } finally {
      window.matchMedia = original;
    }
  });

  it("marks the stage that stopped the session as failed", async () => {
    getSession.mockResolvedValue(
      session({
        state: "FAILED",
        failure: { stage: "CODING", message: "The coding agent exited." },
      }),
    );
    renderDetail();

    expect(await screen.findByTestId("hands-graph-node-code")).toHaveAttribute(
      "data-status",
      "failed",
    );
  });

  it("shows the Linear issue and retries a Done update that failed", async () => {
    getSession.mockResolvedValue(
      session({
        state: "COMPLETED",
        pr: {
          number: 36,
          url: "https://github.com/x/y/pull/36",
          head: { ref: "h", sha: "s" },
        },
        linear: {
          issueId: "issue-ENG-88",
          identifier: "ENG-88",
          title: "Add dark mode",
          url: "https://linear.app/example/issue/eng-88",
          teamId: "team-eng",
          teamKey: "ENG",
          syncedAt: null,
          syncError: "Linear returned 503.",
          doneState: "Shipped",
        },
        warnings: [
          {
            code: "linear_sync_failed",
            files: [],
            message: "Linear returned 503.",
            at: "2026-11-23T00:00:00.000Z",
          },
        ],
      }),
    );
    linearSync.mockResolvedValue(session({ state: "COMPLETED" }));
    renderDetail();

    const section = await screen.findByTestId("hands-linear-section");
    expect(
      within(section).getByRole("link", { name: "ENG-88" }),
    ).toHaveAttribute("href", "https://linear.app/example/issue/eng-88");
    expect(
      within(section).getByText(I18nKey.HANDS$LINEAR_SYNC_FAILED),
    ).toBeInTheDocument();
    expect(screen.getByTestId("hands-warnings")).toHaveTextContent(
      "Linear returned 503.",
    );

    await userEvent.click(
      within(section).getByRole("button", {
        name: I18nKey.HANDS$LINEAR_RETRY_SYNC,
      }),
    );

    await waitFor(() => expect(linearSync).toHaveBeenCalledWith({ id: "s1" }));
  });
});
