import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders } from "test-utils";
import { I18nKey } from "#/i18n/declaration";
import { handsService } from "#/api/hands/hands-service.api";
import type { HandsConnections } from "#/api/hands/hands-types";
import HandsSettingsConnections from "#/routes/hands-settings-connections";

vi.mock("#/api/hands/hands-service.api", () => ({
  handsService: {
    getConnections: vi.fn(),
    getBrowser: vi.fn(),
    addEdgeBrowser: vi.fn(),
  },
}));

const getConnections = vi.mocked(handsService.getConnections);
const getBrowser = vi.mocked(handsService.getBrowser);
const addEdgeBrowser = vi.mocked(handsService.addEdgeBrowser);

const connections: HandsConnections = {
  github: { ok: true, account: "demo-user" },
  linear: { ok: false, error: "linear_key_missing" },
};

describe("HandsSettingsConnections route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConnections.mockResolvedValue(connections);
    getBrowser.mockResolvedValue({ installed: false });
  });

  it("shows the GitHub account and the Linear fix in plain words", async () => {
    renderWithProviders(<HandsSettingsConnections />);

    expect(
      await screen.findByText(I18nKey.HANDS$CONNECTED_AS),
    ).toBeInTheDocument();
    expect(
      screen.getByText(I18nKey.HANDS$ERROR_LINEAR_KEY_MISSING),
    ).toBeInTheDocument();
  });

  it("checks the connections again when asked", async () => {
    renderWithProviders(<HandsSettingsConnections />);

    await userEvent.click(
      await screen.findByRole("button", { name: I18nKey.HANDS$CHECK_AGAIN }),
    );

    await waitFor(() => expect(getConnections).toHaveBeenCalledTimes(2));
  });

  it("adds Microsoft Edge to the agent browser and says so", async () => {
    addEdgeBrowser.mockResolvedValue({ installed: true, added: true });
    renderWithProviders(<HandsSettingsConnections />);

    await userEvent.click(
      await screen.findByRole("button", { name: I18nKey.HANDS$ADD_EDGE }),
    );

    await waitFor(() => expect(addEdgeBrowser).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText(I18nKey.HANDS$ADD_EDGE_ADDED),
    ).toBeInTheDocument();
  });
});
