import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsLinearIssue, HandsSettings } from "#/api/hands/hands-types";
import HandsSettingsLinear from "#/routes/hands-settings-linear";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    listLinearIssues: vi.fn(),
    getLinearTeamStates: vi.fn(),
  },
}));

const getSettings = vi.mocked(handsService.getSettings);
const updateSettings = vi.mocked(handsService.updateSettings);
const listLinearIssues = vi.mocked(handsService.listLinearIssues);
const getLinearTeamStates = vi.mocked(handsService.getLinearTeamStates);

const settings: HandsSettings = {
  gates: { approve_plan: true, open_pr: true },
  autoFixCi: "local",
  ciRepairBudget: 3,
  maxReviewRounds: 2,
  ciPollIntervalMs: 30_000,
  roles: { planner: null, coder: null, reviewer: null },
  linear: {
    teams: {
      ENG: {
        repoDir: "C:\\work\\demo-app",
        baseBranch: "main",
        doneStateId: "state-shipped",
      },
    },
  },
};

const issue = (
  identifier: string,
  team: { id: string; key: string; name: string },
): HandsLinearIssue => ({
  id: `issue-${identifier}`,
  identifier,
  title: "Some issue",
  description: "",
  url: "https://linear.app/example/issue",
  priority: 0,
  updatedAt: new Date().toISOString(),
  state: null,
  team,
  mapped: false,
  session: null,
});

describe("HandsSettingsLinear route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue(settings);
    listLinearIssues.mockResolvedValue([
      issue("ENG-1", { id: "team-eng", key: "ENG", name: "Engineering" }),
      issue("OPS-1", { id: "team-ops", key: "OPS", name: "Operations" }),
    ]);
    getLinearTeamStates.mockImplementation(async ({ teamId }) =>
      teamId === "team-eng"
        ? [
            { id: "state-done", name: "Done", type: "completed" },
            { id: "state-shipped", name: "Shipped", type: "completed" },
          ]
        : [{ id: "ops-done", name: "Done", type: "completed" }],
    );
  });

  it("saves every team with its folder, base branch and Done state", async () => {
    updateSettings.mockResolvedValue(settings);
    renderWithProviders(<HandsSettingsLinear />);

    const ops = await screen.findByTestId("hands-linear-team-OPS");
    await userEvent.type(
      within(ops).getByLabelText(I18nKey.HANDS$LINEAR_REPO_FOLDER),
      "C:\\work\\ops",
    );
    await within(ops).findByRole("option", { name: "Done" });
    await userEvent.selectOptions(
      within(ops).getByLabelText(I18nKey.HANDS$LINEAR_DONE_STATE),
      "ops-done",
    );
    await userEvent.click(
      screen.getByRole("button", { name: I18nKey.HANDS$SETTINGS_SAVE }),
    );

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        linear: {
          teams: {
            ENG: {
              repoDir: "C:\\work\\demo-app",
              baseBranch: "main",
              doneStateId: "state-shipped",
            },
            OPS: {
              repoDir: "C:\\work\\ops",
              baseBranch: null,
              doneStateId: "ops-done",
            },
          },
        },
      }),
    );
  });

  it("rejects a malformed team key and a team that is already listed", async () => {
    renderWithProviders(<HandsSettingsLinear />);
    await screen.findByTestId("hands-linear-team-ENG");

    const keyInput = screen.getByLabelText(I18nKey.HANDS$LINEAR_TEAM_KEY_LABEL);
    await userEvent.type(keyInput, "bad key!");
    await userEvent.click(
      screen.getByRole("button", { name: I18nKey.HANDS$LINEAR_ADD_TEAM }),
    );
    expect(
      await screen.findByText(I18nKey.HANDS$LINEAR_TEAM_KEY_INVALID),
    ).toBeInTheDocument();

    await userEvent.clear(keyInput);
    await userEvent.type(keyInput, "ENG");
    await userEvent.click(
      screen.getByRole("button", { name: I18nKey.HANDS$LINEAR_ADD_TEAM }),
    );
    expect(
      await screen.findByText(I18nKey.HANDS$LINEAR_TEAM_EXISTS),
    ).toBeInTheDocument();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
