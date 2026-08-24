import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";

import { useTestDatabase } from "../../src/lib/testing.js";

useTestDatabase();

const { createApp } = await import("../../src/app.js");
const { resetMerchantAuth } = await import("./merchants.config.js");

beforeAll(() => {
  resetMerchantAuth();
});

const app = createApp();

function requireSessionCookie(response: request.Response): string {
  const cookies = response.headers["set-cookie"];
  if (!cookies) throw new Error("expected a session cookie");
  return cookies;
}

describe("merchant access", () => {
  const email = `merchant-${Date.now()}@example.com`;
  const password = "SuperSecret123!";
  let sessionCookie: string;

  it("registers a merchant and creates a session", async () => {
    const response = await request(app)
      .post("/api/merchants")
      .send({ name: "Ada Payments", email, password });

    expect(response.status).toBe(201);
    const body = response.body as {
      data: { merchant: { email: string } };
    };
    expect(body.data.merchant.email).toBe(email);
    sessionCookie = requireSessionCookie(response);
  });

  it("reads the current merchant from the session", async () => {
    const response = await request(app)
      .get("/api/merchant-sessions/current")
      .set("Cookie", sessionCookie);

    expect(response.status).toBe(200);
    const body = response.body as {
      data: { merchant: { email: string } };
    };
    expect(body.data.merchant.email).toBe(email);
  });

  it("signs in with email and password", async () => {
    const response = await request(app).post("/api/merchant-sessions").send({ email, password });

    expect(response.status).toBe(201);
    expect(response.headers["set-cookie"]).toBeDefined();
  });

  it("requires a session to create a payment link", async () => {
    const response = await request(app)
      .post("/api/payment-links")
      .send({
        destinationAddress: "0xmerchant",
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(401);
  });

  it("creates a payment link owned by the signed-in merchant", async () => {
    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        destinationAddress: "0xmerchant",
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        description: "Consulting",
      });

    expect(response.status).toBe(201);
    const body = response.body as {
      data: { paymentIntent: Record<string, unknown> };
    };
    expect(body.data.paymentIntent).toMatchObject({
      destinationAddress: "0xmerchant",
      amountAtomic: "1000000",
      asset: "USDC",
      chain: "base",
      approvalRequired: true,
    });
    expect(body.data.paymentIntent).not.toHaveProperty("merchantId");
  });
});
