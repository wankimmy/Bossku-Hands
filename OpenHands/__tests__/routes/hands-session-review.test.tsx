import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, useParamsMock } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSession, HandsSessionDiff } from "#/api/hands/hands-types";
import HandsSessionReview from "#/routes/hands-session-review";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: {
    getSession: vi.fn(),
    getSessionDiff: vi.fn(),
    approve: vi.fn(),
  },
}));

const getSession = vi.mocked(handsService.getSession);
const getSessionDiff = vi.mocked(handsService.getSessionDiff);
const approve = vi.mocked(handsService.approve);

const session = (overrides: Partial<HandsSession> = {}): HandsSession =>
  ({
    id: "s1",
    state: "AWAITING_APPROVAL",
    request: { source: "ui", task: "Add export", repoDir: "C:\\work\\demo" },
    repoDir: "C:\\work\\demo",
    baseBranch: "main",
    branch: "hands/s1",
    plan: "Step one: add the export button",
    review: { verdict: "APPROVE", notes: "Looks good to me" },
    pendingApproval: "open_pr",
    pr: { number: 12, url: "https://github.com/example/demo/pull/12" },
    counters: { reviewRounds: 1, ciRepairRounds: 0 },
    settings: { ciRepairBudget: 3 },
    warnings: [],
    events: [],
    ...overrides,
  }) as HandsSession;

const diff = (overrides: Partial<HandsSessionDiff> = {}): HandsSessionDiff => ({
  base: "main",
  branch: "hands/s1",
  files: [
    { path: "src/export.ts", additions: 3, deletions: 1 },
    { path: "public/logo.png", additions: null, deletions: null },
  ],
  patch: "@@ -1,2 +1,2 @@\n-old line\n+new line\n context",
  truncated: false,
  ...overrides,
});

const renderReview = () => {
  useParamsMock.mockReturnValue({ sessionId: "s1" } as never);
  return renderWithProviders(<HandsSessionReview />);
};

describe("HandsSessionReview route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists changed files with line counts, marks binary files and shows the diff", async () => {
    getSession.mockResolvedValue(session());
    getSessionDiff.mockResolvedValue(diff({ truncated: true }));
    renderReview();

    const file = await screen.findByTestId("hands-review-file-src/export.ts");
    expect(within(file).getByText("+3")).toBeInTheDocument();
    expect(within(file).getByText("-1")).toBeInTheDocument();
    const binary = screen.getByTestId("hands-review-file-public/logo.png");
    expect(
      within(binary).getByText(I18nKey.HANDS$DIFF_BINARY),
    ).toBeInTheDocument();

    const code = screen.getByTestId("hands-diff");
    expect(code).toHaveTextContent("+new line");
    expect(code).toHaveTextContent("-old line");
    expect(screen.getByText(I18nKey.HANDS$DIFF_TRUNCATED)).toBeInTheDocument();
  });

  it("shows the plan and the AI review notes", async () => {
    getSession.mockResolvedValue(session());
    getSessionDiff.mockResolvedValue(diff());
    renderReview();

    expect(
      await screen.findByText("Step one: add the export button"),
    ).toBeInTheDocument();
    expect(screen.getByText("Looks good to me")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: I18nKey.HANDS$PR_LINK }),
    ).toHaveAttribute("href", "https://github.com/example/demo/pull/12");
  });

  it("approves exactly the pending gate", async () => {
    getSession.mockResolvedValue(session());
    getSessionDiff.mockResolvedValue(diff());
    approve.mockResolvedValue(session({ state: "WATCHING_CI" }));
    renderReview();

    await userEvent.click(await screen.findByTestId("hands-review-approve"));

    await waitFor(() =>
      expect(approve).toHaveBeenCalledWith({ id: "s1", gate: "open_pr" }),
    );
  });

  it("says there are no changes yet when the branch has no commits", async () => {
    getSession.mockResolvedValue(
      session({ state: "PLANNING", pendingApproval: null }),
    );
    getSessionDiff.mockResolvedValue(diff({ files: [], patch: "" }));
    renderReview();

    expect(
      await screen.findByText(I18nKey.HANDS$NO_CHANGES),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("hands-review-approve"),
    ).not.toBeInTheDocument();
  });
});
