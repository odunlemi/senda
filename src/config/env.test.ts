import { describe, expect, it } from "vitest";

import { parseEnvironment } from "./env.js";

const baseEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgres://postgres:postgres@localhost:5432/senda",
  BETTER_AUTH_SECRET: "test-secret-that-is-at-least-thirty-two-characters",
  BETTER_AUTH_URL: "http://localhost:3000",
};

describe("operational alert environment", () => {
  it("allows explicitly disabled delivery without destination credentials", () => {
    expect(
      parseEnvironment({ ...baseEnvironment, OPERATIONAL_ALERTS_MODE: "disabled" }),
    ).toMatchObject({ OPERATIONAL_ALERTS_MODE: "disabled" });
  });

  it("treats blank example webhook values as unset in disabled mode", () => {
    expect(
      parseEnvironment({
        ...baseEnvironment,
        OPERATIONAL_ALERTS_MODE: "disabled",
        OPERATIONAL_ALERT_WEBHOOK_URL: "",
        OPERATIONAL_ALERT_WEBHOOK_TOKEN: "",
      }),
    ).toMatchObject({
      OPERATIONAL_ALERTS_MODE: "disabled",
      OPERATIONAL_ALERT_WEBHOOK_URL: undefined,
      OPERATIONAL_ALERT_WEBHOOK_TOKEN: undefined,
    });
  });

  it("rejects webhook mode when destination configuration is missing", () => {
    expect(() =>
      parseEnvironment({ ...baseEnvironment, OPERATIONAL_ALERTS_MODE: "webhook" }),
    ).toThrow(/OPERATIONAL_ALERT_WEBHOOK_URL/);
  });

  it("accepts a configured webhook whose lease exceeds its timeout", () => {
    expect(
      parseEnvironment({
        ...baseEnvironment,
        OPERATIONAL_ALERTS_MODE: "webhook",
        OPERATIONAL_ALERT_WEBHOOK_URL: "https://operators.example.test/senda",
        OPERATIONAL_ALERT_WEBHOOK_TOKEN: "server-only-test-token",
        OPERATIONAL_ALERT_TIMEOUT_MS: "5000",
        OPERATIONAL_ALERT_LEASE_MS: "60000",
      }),
    ).toMatchObject({
      OPERATIONAL_ALERTS_MODE: "webhook",
      OPERATIONAL_ALERT_WEBHOOK_URL: "https://operators.example.test/senda",
    });
  });

  it("requires HTTPS for a production webhook destination", () => {
    expect(() =>
      parseEnvironment({
        ...baseEnvironment,
        NODE_ENV: "production",
        OPERATIONAL_ALERTS_MODE: "webhook",
        OPERATIONAL_ALERT_WEBHOOK_URL: "http://operators.example.test/senda",
        OPERATIONAL_ALERT_WEBHOOK_TOKEN: "server-only-test-token",
      }),
    ).toThrow(/Must use HTTPS in production/);
  });
});
