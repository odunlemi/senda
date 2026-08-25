import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import { paymentConfig } from "../../src/config/payment.js";
import { setBaseTransactionProvider } from "./checkout.provider.js";

useTestDatabase();

const { createApp } = await import("../../src/app.js");
const { createPaymentIntent } = await import("../payment-intents/payment-intents.service.js");

const app = createApp();
const destinationAddress = "0x1111111111111111111111111111111111111111";
const payerAddress = "0x2222222222222222222222222222222222222222";
const transactionHash = `0x${"a".repeat(64)}`;

interface CheckoutBody {
  data: {
    paymentIntent: Record<string, unknown>;
    transactionRequest: Record<string, unknown>;
  };
}

function transferInput(destination: string, amountAtomic: string): string {
  return `0xa9059cbb${destination.slice(2).padStart(64, "0")}${BigInt(amountAtomic)
    .toString(16)
    .padStart(64, "0")}`;
}

beforeAll(async () => {
  await sql`
    insert into "user" ("id", "name", "email", "receivingWalletAddress")
    values ('checkout-merchant', 'Checkout Merchant', 'checkout@example.com', ${destinationAddress})
  `.execute(getDb());
});

describe("guided checkout", () => {
  it("prepares an exact Base USDC transfer request", async () => {
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1000000",
      expiresAt: new Date(Date.now() + 60_000),
    });

    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/checkout`,
    );

    expect(response.status).toBe(200);
    const body = response.body as CheckoutBody;
    expect(body.data.transactionRequest).toEqual({
      chainId: paymentConfig.chainId,
      to: paymentConfig.assetContractAddress,
      data: transferInput(destinationAddress, "1000000"),
      value: "0x0",
    });
    expect(body.data.paymentIntent.status).toBe("awaiting_payment");

    const repeatedResponse = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/checkout`,
    );
    expect(repeatedResponse.status).toBe(200);
  });

  it("records a matching approved transaction as confirming", async () => {
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash: transactionHash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2500000"),
          value: "0x0",
        }),
    });

    const response = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash });

    expect(response.status).toBe(200);
    const body = response.body as CheckoutBody;
    expect(body.data.paymentIntent).toMatchObject({
      status: "confirming",
      payerAddress,
      transactionHash,
    });

    const repeatedResponse = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash });
    expect(repeatedResponse.status).toBe(200);
  });

  it("rejects a transaction whose transfer does not match the intent", async () => {
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "3000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash: transactionHash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1"),
          value: "0x0",
        }),
    });

    const response = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Transaction does not match this payment link",
    });
  });
});
