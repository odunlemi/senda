import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import { paymentConfig } from "../../src/config/payment.js";
import { setBaseTransactionProvider } from "./checkout.provider.js";
import {
  reconcileConfirmingPaymentIntents,
  reconcilePaidPaymentIntents,
} from "./checkout.worker.js";

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

function usdcTransferLog(payer: string, destination: string, amountAtomic: string) {
  return {
    address: paymentConfig.assetContractAddress,
    topics: [
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
      `0x${"0".repeat(24)}${payer.slice(2)}`,
      `0x${"0".repeat(24)}${destination.slice(2)}`,
    ],
    data: `0x${BigInt(amountAtomic).toString(16).padStart(64, "0")}`,
  };
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

  it("returns paid when submission races with reconciliation", async () => {
    const hash = `0x${"3".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2850000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: async () => {
        await getDb()
          .updateTable("paymentIntents")
          .set({
            status: "paid",
            payerAddress,
            transactionHash: hash,
            confirmationCount: paymentConfig.requiredConfirmations,
            updatedAt: new Date(),
          })
          .where("publicId", "=", paymentIntent.publicId)
          .execute();
        return {
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2850000"),
          value: "0x0",
        };
      },
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    const response = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "paid",
      transactionHash: hash,
    });
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
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "4000000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
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
      confirmationCount: 12,
    });
  });

  it("reconciles confirming intents without a checkout-page request", async () => {
    const hash = `0x${"2".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "9000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "9000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x40",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "9000000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x4b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await reconcileConfirmingPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "confirmationCount"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ status: "paid", confirmationCount: 12 });
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
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x20",
          status: "0x0",
          logs: [],
        }),
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

describe("receipt log validation", () => {
  it("marks a successful receipt without a matching Transfer log as failed", async () => {
    const hash = `0x${"4".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "failed",
      confirmationCount: 12,
    });
  });
});

describe("reorg monitoring", () => {
  it("sets paidAt when a mined successful transaction is marked paid", async () => {
    const hash = `0x${"5".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1200000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1200000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1200000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "paidAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.paidAt).not.toBeNull();
  });

  it("keeps a valid paid receipt from being flagged as reorged", async () => {
    const hash = `0x${"8".repeat(63)}0`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1400000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1400000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1400000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    await getDb()
      .updateTable("paymentIntents")
      .set({ reorgDetectedAt: new Date() })
      .where("status", "=", "paid")
      .where("publicId", "!=", paymentIntent.publicId)
      .execute();

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1400000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1400000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });
    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "reorgDetectedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.reorgDetectedAt).toBeNull();
  });

  it("does not record a reorg for a transiently missing receipt", async () => {
    const hash = `0x${"8".repeat(63)}1`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1500000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    await getDb()
      .updateTable("paymentIntents")
      .set({ reorgDetectedAt: new Date() })
      .where("status", "=", "paid")
      .where("publicId", "!=", paymentIntent.publicId)
      .execute();

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });
    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "reorgDetectedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.reorgDetectedAt).toBeNull();
  });

  it("records a reorg when a paid receipt is reverted", async () => {
    const hash = `0x${"8".repeat(63)}2`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1600000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1600000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1600000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    await getDb()
      .updateTable("paymentIntents")
      .set({ reorgDetectedAt: new Date() })
      .where("status", "=", "paid")
      .where("publicId", "!=", paymentIntent.publicId)
      .execute();

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1600000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x0",
          logs: [],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });
    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "reorgDetectedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.reorgDetectedAt).not.toBeNull();
  });

  it("records a reorg when a paid receipt loses its Transfer log", async () => {
    const hash = `0x${"8".repeat(63)}3`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1700000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1700000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1700000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    await getDb()
      .updateTable("paymentIntents")
      .set({ reorgDetectedAt: new Date() })
      .where("status", "=", "paid")
      .where("publicId", "!=", paymentIntent.publicId)
      .execute();

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1700000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });
    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "reorgDetectedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.reorgDetectedAt).not.toBeNull();
  });

  it("records a reorg when both transaction and receipt disappear", async () => {
    const hash = `0x${"8".repeat(63)}4`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1800000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1800000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1800000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    await getDb()
      .updateTable("paymentIntents")
      .set({ reorgDetectedAt: new Date() })
      .where("status", "=", "paid")
      .where("publicId", "!=", paymentIntent.publicId)
      .execute();

    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });
    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "reorgDetectedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.reorgDetectedAt).not.toBeNull();
  });
});

describe("confirming timeout", () => {
  it("marks a stale confirming intent as dropped", async () => {
    const hash = `0x${"0".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "3500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "3500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });

    const timeoutAgo = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await sql`
      update "paymentIntents" set "updatedAt" = ${timeoutAgo}
      where "publicId" = ${paymentIntent.publicId}
    `.execute(getDb());

    const response = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );

    expect(response.status).toBe(200);
    expect((response.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "dropped",
    });
  });

  it("keeps a fresh confirming intent in confirming", async () => {
    const hash = `0x${"9".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "4500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "4500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
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
    });
  });

  it("drops stale confirming intents in the background worker", async () => {
    const hash = `0x${"7".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "5500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "5500000"),
          value: "0x0",
        }),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });

    const timeoutAgo = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await sql`
      update "paymentIntents" set "updatedAt" = ${timeoutAgo}
      where "publicId" = ${paymentIntent.publicId}
    `.execute(getDb());

    await reconcileConfirmingPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select("status")
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("dropped");
  });
});
