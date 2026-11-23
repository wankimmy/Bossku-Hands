import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSession, HandsSessionState } from "#/api/hands/hands-types";
import HandsReviews from "#/routes/hands-reviews";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: { listSessions: vi.fn() },
}));

const listSessions = vi.mocked(handsService.listSessions);

const session = (id: string, state: HandsSessionState): HandsSession =>
  ({
    id,
    state,
    request: { source: "ui", task: `Task ${id}`, repoDir: "C:\\work\\demo" },
    repoDir: "C:\\work\\demo",
    pr: null,
    updatedAt: new Date().toISOString(),
  }) as HandsSession;

describe("HandsReviews route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists only sessions that wait for a person, each linking to its review", async () => {
    listSessions.mockResolvedValue([
      session("s-plan", "AWAITING_APPROVAL"),
      session("s-ready", "READY_FOR_HUMAN_REVIEW"),
      session("s-ci", "WATCHING_CI"),
    ]);
    renderWithProviders(<HandsReviews />);

    const plan = await screen.findByTestId("hands-review-row-s-plan");
    expect(
      within(plan)
        .getByRole("link", { name: I18nKey.HANDS$REVIEW_OPEN })
        .getAttribute("href"),
    ).toContain("/hands/sessions/s-plan/review");
    expect(screen.getByTestId("hands-review-row-s-ready")).toBeInTheDocument();
    expect(
      screen.queryByTestId("hands-review-row-s-ci"),
    ).not.toBeInTheDocument();
  });

  it("shows an empty state when nothing needs review", async () => {
    listSessions.mockResolvedValue([session("s-ci", "WATCHING_CI")]);
    renderWithProviders(<HandsReviews />);

    expect(
      await screen.findByText(I18nKey.HANDS$REVIEWS_EMPTY),
    ).toBeInTheDocument();
  });
});
