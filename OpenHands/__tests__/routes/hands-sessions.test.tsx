import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSession } from "#/api/hands/hands-types";
import HandsSessions from "#/routes/hands-sessions";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: { listSessions: vi.fn(), startSession: vi.fn() },
}));

const listSessions = vi.mocked(handsService.listSessions);
const startSession = vi.mocked(handsService.startSession);

const session = (overrides: Partial<HandsSession> = {}): HandsSession =>
  ({
    id: "s1",
    state: "WATCHING_CI",
    request: {
      source: "ui",
      task: "Fix login\nmore detail",
      repoDir: "C:\\work\\demo-app",
    },
    repoDir: "C:\\work\\demo-app",
    baseBranch: "main",
    pr: {
      number: 7,
      url: "https://github.com/x/y/pull/7",
      head: { ref: "h", sha: "s" },
    },
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as HandsSession;

describe("HandsSessions route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists sessions with title, repo folder, state text and PR link", async () => {
    listSessions.mockResolvedValue([session()]);
    renderWithProviders(<HandsSessions />);

    const row = await screen.findByTestId("hands-session-row-s1");
    expect(row).toHaveTextContent("Fix login");
    expect(row).not.toHaveTextContent("more detail");
    expect(row).toHaveTextContent("demo-app");
    expect(row).toHaveTextContent(I18nKey.HANDS$STATE_WATCHING_CI);
    expect(
      screen.getByRole("link", { name: I18nKey.HANDS$PR_LINK }),
    ).toHaveAttribute("href", "https://github.com/x/y/pull/7");
  });

  it("shows the empty state when there are no sessions", async () => {
    listSessions.mockResolvedValue([]);
    renderWithProviders(<HandsSessions />);

    expect(
      await screen.findByTestId("hands-sessions-empty"),
    ).toBeInTheDocument();
  });

  it("shows an error with retry when the list cannot load", async () => {
    listSessions.mockRejectedValueOnce(new Error("down"));
    listSessions.mockResolvedValue([]);
    renderWithProviders(<HandsSessions />);

    expect(
      await screen.findByTestId("hands-sessions-error"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: I18nKey.HANDS$RETRY }),
    );
    expect(
      await screen.findByTestId("hands-sessions-empty"),
    ).toBeInTheDocument();
  });

  it("starts a task and navigates to its detail page", async () => {
    listSessions.mockResolvedValue([]);
    startSession.mockResolvedValue(session({ id: "new-1" }));
    const navigate = vi.fn();
    renderWithProviders(<HandsSessions />, { navigation: { navigate } });

    await userEvent.type(screen.getByTestId("hands-task-input"), "Add tests");
    await userEvent.type(
      screen.getByTestId("hands-repo-input"),
      "C:\\work\\demo-app",
    );
    await userEvent.click(screen.getByTestId("hands-start-task"));

    await waitFor(() =>
      expect(startSession).toHaveBeenCalledWith({
        task: "Add tests",
        repoDir: "C:\\work\\demo-app",
      }),
    );
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("/hands/sessions/new-1"),
    );
  });

  it("maps a server error code to a readable message and stays on the page", async () => {
    listSessions.mockResolvedValue([]);
    startSession.mockRejectedValue(
      new HandsApiError("x", { code: "not_a_git_repository", status: 400 }),
    );
    const navigate = vi.fn();
    renderWithProviders(<HandsSessions />, { navigation: { navigate } });

    await userEvent.type(screen.getByTestId("hands-task-input"), "Add tests");
    await userEvent.type(screen.getByTestId("hands-repo-input"), "C:\\nope");
    await userEvent.click(screen.getByTestId("hands-start-task"));

    expect(await screen.findByTestId("hands-start-error")).toHaveTextContent(
      I18nKey.HANDS$ERROR_NOT_A_GIT_REPOSITORY,
    );
    expect(navigate).not.toHaveBeenCalled();
  });
});
