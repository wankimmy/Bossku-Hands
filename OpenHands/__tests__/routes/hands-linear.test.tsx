import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsLinearIssue, HandsSession } from "#/api/hands/hands-types";
import HandsLinear from "#/routes/hands-linear";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: {
    listLinearIssues: vi.fn(),
    startLinearIssue: vi.fn(),
  },
}));

const listLinearIssues = vi.mocked(handsService.listLinearIssues);
const startLinearIssue = vi.mocked(handsService.startLinearIssue);

const issue = (
  overrides: Partial<HandsLinearIssue> = {},
): HandsLinearIssue => ({
  id: "issue-1",
  identifier: "ENG-101",
  title: "Add export button",
  description: "",
  url: "https://linear.app/example/issue/eng-101",
  priority: 2,
  updatedAt: new Date().toISOString(),
  state: { id: "state-todo", name: "Todo", type: "unstarted" },
  team: { id: "team-eng", key: "ENG", name: "Engineering" },
  mapped: true,
  session: null,
  ...overrides,
});

const rowFor = (identifier: string) =>
  screen.getByTestId(`hands-linear-issue-${identifier}`);

describe("HandsLinear route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("starts a session for a mapped issue and confirms it", async () => {
    listLinearIssues.mockResolvedValue([issue()]);
    startLinearIssue.mockResolvedValue({ id: "s-new" } as HandsSession);
    renderWithProviders(<HandsLinear />);

    const row = await waitFor(() => rowFor("ENG-101"));
    await userEvent.click(
      within(row).getByRole("button", {
        name: I18nKey.HANDS$LINEAR_START_SESSION,
      }),
    );

    await waitFor(() =>
      expect(startLinearIssue).toHaveBeenCalledWith({ issueId: "issue-1" }),
    );
    expect(
      await screen.findByText(I18nKey.HANDS$LINEAR_SESSION_STARTED),
    ).toBeInTheDocument();
  });

  it("disables start for an unmapped team and links to the team setup", async () => {
    listLinearIssues.mockResolvedValue([
      issue({
        identifier: "OPS-7",
        mapped: false,
        team: { id: "team-ops", key: "OPS", name: "Operations" },
      }),
    ]);
    renderWithProviders(<HandsLinear />);

    const row = await waitFor(() => rowFor("OPS-7"));
    expect(
      within(row).getByRole("button", {
        name: I18nKey.HANDS$LINEAR_START_SESSION,
      }),
    ).toBeDisabled();
    const setup = within(row).getByRole("link", {
      name: I18nKey.HANDS$LINEAR_SET_UP_TEAM,
    });
    expect(setup.getAttribute("href")).toContain("/settings/hands-linear");
    expect(startLinearIssue).not.toHaveBeenCalled();
  });

  it("links to the existing session instead of offering a second start", async () => {
    listLinearIssues.mockResolvedValue([
      issue({ session: { id: "s-9", state: "CODING" } }),
    ]);
    renderWithProviders(<HandsLinear />);

    const row = await waitFor(() => rowFor("ENG-101"));
    expect(
      within(row).queryByRole("button", {
        name: I18nKey.HANDS$LINEAR_START_SESSION,
      }),
    ).not.toBeInTheDocument();
    const open = within(row).getByRole("link", {
      name: I18nKey.HANDS$LINEAR_OPEN_SESSION,
    });
    expect(open.getAttribute("href")).toContain("/hands/sessions/s-9");
  });

  it("names the environment variable when the Linear key is missing", async () => {
    listLinearIssues.mockRejectedValue(
      new HandsApiError("missing", { code: "linear_key_missing", status: 400 }),
    );
    renderWithProviders(<HandsLinear />);

    expect(
      await screen.findByText(I18nKey.HANDS$ERROR_LINEAR_KEY_MISSING),
    ).toBeInTheDocument();
  });

  it("shows the running session when the issue is already in progress", async () => {
    listLinearIssues.mockResolvedValue([issue()]);
    startLinearIssue.mockRejectedValue(
      new HandsApiError("in progress", {
        code: "linear_issue_in_progress",
        status: 409,
        sessionId: "s-7",
      }),
    );
    renderWithProviders(<HandsLinear />);

    const row = await waitFor(() => rowFor("ENG-101"));
    await userEvent.click(
      within(row).getByRole("button", {
        name: I18nKey.HANDS$LINEAR_START_SESSION,
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      I18nKey.HANDS$ERROR_LINEAR_ISSUE_IN_PROGRESS,
    );
    const link = within(alert).getByRole("link", {
      name: I18nKey.HANDS$LINEAR_OPEN_SESSION,
    });
    expect(link.getAttribute("href")).toContain("/hands/sessions/s-7");
  });

  it("shows an empty state when no issues are assigned", async () => {
    listLinearIssues.mockResolvedValue([]);
    renderWithProviders(<HandsLinear />);

    expect(
      await screen.findByText(I18nKey.HANDS$LINEAR_EMPTY),
    ).toBeInTheDocument();
  });
});
