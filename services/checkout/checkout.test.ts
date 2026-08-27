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
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const response = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: `0x${"A".repeat(64)}` });

    expect(response.status).toBe(200);
    const body = response.body as CheckoutBody;
    expect(body.data.paymentIntent).toMatchObject({
      status: "confirming",
      payerAddress,
      transactionHash: transactionHash.toLowerCase(),
    });

    const repeatedResponse = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash });
    expect(repeatedResponse.status).toBe(200);
  });

  it("normalizes a mixed-case hash and safely handles concurrent submissions", async () => {
    const hash = `0x${"f".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2750000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2750000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const responses = await Promise.all(
      [0, 1].map(() =>
        request(app)
          .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
          .send({ transactionHash: `0x${"F".repeat(64)}` }),
      ),
    );

    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(
      responses.every(
        (response) => (response.body as CheckoutBody).data.paymentIntent.transactionHash === hash,
      ),
    ).toBe(true);
  });

  it("rejects reusing a transaction hash on another payment link", async () => {
    const hash = `0x${"1".repeat(64)}`;
    const firstIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "7000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const secondIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "8000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${firstIntent.publicId}/checkout`);
    await request(app).post(`/api/payment-links/${secondIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "7000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const firstResponse = await request(app)
      .post(`/api/payment-links/${firstIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    expect(firstResponse.status).toBe(200);

    const secondResponse = await request(app)
      .post(`/api/payment-links/${secondIntent.publicId}/transactions`)
      .send({ transactionHash: hash.toUpperCase() });
    expect(secondResponse.status).toBe(400);
    expect(secondResponse.body).toEqual({
      success: false,
      error: "Transaction is already associated with another payment link",
    });
  });

  it("reconciles a mined successful transaction as paid", async () => {
    const hash = `0x${"b".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "4000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "4000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({ transactionHash: hash, blockNumber: "0x10", status: "0x1" }),
      getCurrentBlockNumber: () => Promise.resolve(0x10),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "paid",
      confirmationCount: 1,
    });
  });

  it("marks a reverted transaction as failed", async () => {
    const hash = `0x${"c".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "5000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "5000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({ transactionHash: hash, blockNumber: "0x20", status: "0x0" }),
      getCurrentBlockNumber: () => Promise.resolve(0x20),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent.status).toBe("failed");
  });

  it("keeps pending transactions in confirming", async () => {
    const hash = `0x${"d".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "6000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "6000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0x30),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "confirming",
      confirmationCount: 0,
    });
  });

  it("rejects a transaction whose transfer does not match the intent", async () => {
    const hash = `0x${"e".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "3000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const response = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      success: false,
      error: "Transaction does not match this payment link",
    });
  });
});
