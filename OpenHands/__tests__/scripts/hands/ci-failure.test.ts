// @vitest-environment node
import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../../scripts/hands/ci-failure.mjs";
import { isSecretFile } from "../../../scripts/hands/git.mjs";

describe("redactSecrets", () => {
  it("masks well-known token shapes and key=value credentials", () => {
    const out = redactSecrets(
      "token=abc123def456 ghp_abcdefghijklmnopqrstuvwxyz0123456789 Authorization: Bearer abcdefghijklmnopqrstuv",
    );
    expect(out).not.toMatch(/abc123def456|ghp_abcdef|abcdefghijklmnopqrstuv/);
  });

  it("masks NAME_TOKEN=value forms, where the key is part of a longer name", () => {
    const out = redactSecrets(
      "BOSSKU_HANDS_GITHUB_TOKEN=abcdefghijk123 GH_TOKEN=zzzzzzzz9 DB_PASSWORD: hunter2hunter LINEAR_API_KEY=lin123456789",
    );
    expect(out).not.toMatch(
      /abcdefghijk123|zzzzzzzz9|hunter2hunter|lin123456789/,
    );
    expect(out).toContain("BOSSKU_HANDS_GITHUB_TOKEN=[REDACTED]");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSecrets("tokenizer=fast tests passed: 12")).toBe(
      "tokenizer=fast tests passed: 12",
    );
  });
});

describe("isSecretFile", () => {
  it.each([
    ".env",
    ".env.local",
    "config/prod.env",
    ".envrc",
    ".dev.vars",
    "secrets.json",
    "config/secrets.yaml",
    "infra/terraform.tfvars",
    "service-account-key.json",
    "deploy.pem",
    "id_ed25519",
    ".npmrc",
  ])("treats %s as secret", (file) => {
    expect(isSecretFile(file)).toBe(true);
  });

  it.each([
    ".env.example",
    ".env.sample",
    "src/environment.ts",
    "docs/secrets-handling.md",
    "src/tokens.css",
  ])("keeps %s", (file) => {
    expect(isSecretFile(file)).toBe(false);
  });
});
