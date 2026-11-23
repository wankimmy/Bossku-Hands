import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { HandsApiError } from "#/api/hands/hands-error";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsSettings } from "#/api/hands/hands-types";
import AgentProfilesService from "#/api/agent-profiles-service/agent-profiles-service.api";
import HandsSettingsWorkflow from "#/routes/hands-settings-workflow";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: { getSettings: vi.fn(), updateSettings: vi.fn() },
}));
vi.mock("#/api/agent-profiles-service/agent-profiles-service.api", () => ({
  default: { listProfiles: vi.fn() },
}));

const getSettings = vi.mocked(handsService.getSettings);
const updateSettings = vi.mocked(handsService.updateSettings);

const settings: HandsSettings = {
  gates: { approve_plan: true, open_pr: true },
  autoFixCi: "local",
  ciRepairBudget: 3,
  maxReviewRounds: 2,
  ciPollIntervalMs: 30_000,
  roles: { planner: null, coder: null, reviewer: null },
  linear: { teams: {} },
};

describe("HandsSettingsWorkflow route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSettings.mockResolvedValue(settings);
    vi.mocked(AgentProfilesService.listProfiles).mockResolvedValue({
      profiles: [{ id: "coder-1", name: "Fast coder" }],
      active_agent_profile_id: null,
    } as never);
  });

  it("saves the edited settings, mapping seconds to ms and Not chosen to null", async () => {
    updateSettings.mockResolvedValue(settings);
    renderWithProviders(<HandsSettingsWorkflow />);

    await userEvent.click(
      await screen.findByRole("checkbox", { name: I18nKey.HANDS$GATE_OPEN_PR }),
    );
    await userEvent.click(
      screen.getByRole("radio", {
        name: I18nKey.HANDS$AUTO_FIX_UPDATE_PR,
      }),
    );
    const budget = screen.getByTestId("hands-ci-repair-budget");
    await userEvent.clear(budget);
    await userEvent.type(budget, "5");
    const poll = screen.getByTestId("hands-ci-poll-seconds");
    await userEvent.clear(poll);
    await userEvent.type(poll, "60");
    await within(screen.getByTestId("hands-role-coder")).findByRole("option", {
      name: "Fast coder",
    });
    await userEvent.selectOptions(
      screen.getByTestId("hands-role-coder"),
      "coder-1",
    );
    await userEvent.click(screen.getByTestId("hands-settings-save"));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        gates: { approve_plan: true, open_pr: false },
        autoFixCi: "update_pr",
        ciRepairBudget: 5,
        maxReviewRounds: 2,
        ciPollIntervalMs: 60_000,
        roles: { planner: null, coder: "coder-1", reviewer: null },
      }),
    );
    expect(
      await screen.findByTestId("hands-settings-saved"),
    ).toBeInTheDocument();
  });

  it("shows the server's invalid_settings error on the named field", async () => {
    updateSettings.mockRejectedValue(
      new HandsApiError("bad", {
        code: "invalid_settings",
        field: "ciRepairBudget",
        status: 400,
      }),
    );
    renderWithProviders(<HandsSettingsWorkflow />);

    await userEvent.click(await screen.findByTestId("hands-settings-save"));

    expect(
      await screen.findByTestId("hands-ci-repair-budget-error"),
    ).toHaveTextContent(I18nKey.HANDS$FIELD_INVALID);
    expect(
      screen.queryByTestId("hands-settings-saved"),
    ).not.toBeInTheDocument();
  });
});
