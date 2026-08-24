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
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(401);
  });

  it("requires the merchant to configure a receiving wallet", async () => {
    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Merchant receiving wallet is not configured",
    });
  });

  it("configures one receiving wallet and derives payment destinations from it", async () => {
    const wallet = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const walletResponse = await request(app)
      .put("/api/merchant-wallet")
      .set("Cookie", sessionCookie)
      .send({ receivingWalletAddress: wallet });

    expect(walletResponse.status).toBe(200);
    const walletBody = walletResponse.body as {
      data: { receivingWalletAddress: string };
    };
    expect(walletBody.data.receivingWalletAddress).toBe(wallet);

    const response = await request(app)
      .post("/api/payment-links")
      .set("Cookie", sessionCookie)
      .send({
        destinationAddress: "0x1111111111111111111111111111111111111111",
        amountAtomic: "1000000",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      });

    expect(response.status).toBe(201);
    const paymentBody = response.body as {
      data: { paymentIntent: { destinationAddress: string } };
    };
    expect(paymentBody.data.paymentIntent.destinationAddress).toBe(wallet);
  });

  it("returns 400 for invalid payment-link amounts and expiry", async () => {
    const cases = [
      { amountAtomic: "0", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { amountAtomic: "1000000", expiresAt: new Date(Date.now() - 60_000).toISOString() },
    ];

    for (const body of cases) {
      const response = await request(app)
        .post("/api/payment-links")
        .set("Cookie", sessionCookie)
        .send(body);
      expect(response.status).toBe(400);
    }
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
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      amountAtomic: "1000000",
      asset: "USDC",
      chain: "base",
      approvalRequired: true,
    });
    expect(body.data.paymentIntent).not.toHaveProperty("merchantId");
  });
});
