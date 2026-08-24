import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";

useTestDatabase();

beforeAll(async () => {
  await sql`
    insert into "user" ("id", "name", "email")
    values
      ('merchant-1', 'Merchant One', 'merchant-1@example.com'),
      ('merchant-2', 'Merchant Two', 'merchant-2@example.com')
  `.execute(getDb());
});

const { createApp } = await import("../../src/app.js");
const { createPaymentIntent } = await import("./payment-intents.service.js");

const app = createApp();

describe("payment intents", () => {
  it("creates a Base USDC payment intent that requires approval", async () => {
    const paymentIntent = await createPaymentIntent({
      merchantId: "merchant-1",
      destinationAddress: "0xmerchant",
      amountAtomic: "10000000",
      expiresAt: new Date(Date.now() + 60_000),
      description: "Test payment",
    });

    expect(paymentIntent).toMatchObject({
      amountAtomic: "10000000",
      asset: "USDC",
      chain: "base",
      approvalRequired: true,
      destinationAddress: "0xmerchant",
      status: "created",
    });
    expect(paymentIntent).not.toHaveProperty("merchantId");
  });

  it("reads a payment intent through its public payment link", async () => {
    const paymentIntent = await createPaymentIntent({
      merchantId: "merchant-2",
      destinationAddress: "0xmerchant",
      amountAtomic: "2500000",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await request(app).get(`/api/payment-links/${paymentIntent.publicId}`);

    expect(response.status).toBe(200);
    const body = response.body as {
      data: { paymentIntent: Record<string, unknown> };
    };
    expect(body.data.paymentIntent).toMatchObject({
      publicId: paymentIntent.publicId,
      amountAtomic: "2500000",
      asset: "USDC",
      chain: "base",
      approvalRequired: true,
    });
  });

  it("rejects an unknown payment link", async () => {
    const response = await request(app).get("/api/payment-links/does-not-exist");

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ success: false, error: "Payment link not found" });
  });
});
