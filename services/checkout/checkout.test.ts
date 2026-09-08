import { randomUUID } from "node:crypto";

import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";
import { paymentConfig } from "../../src/config/payment.js";
import { setBaseTransactionProvider } from "./checkout.provider.js";
import {
  reconcilePaidPaymentIntents,
  reconcileUnresolvedPaymentIntents,
} from "./checkout.worker.js";
import { reconcileCheckout } from "./checkout.service.js";

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

async function associatePaymentForTest(input: {
  publicId: string;
  transactionHash: string;
  submittedAt: Date;
  status?: "confirming" | "dropped";
  monitoringExpiresAt?: Date;
}): Promise<void> {
  await getDb()
    .updateTable("paymentIntents")
    .set({
      status: input.status ?? "confirming",
      payerAddress,
      transactionHash: input.transactionHash,
      submittedAt: input.submittedAt,
      monitoringExpiresAt:
        input.monitoringExpiresAt ??
        new Date(input.submittedAt.getTime() + paymentConfig.droppedMonitoringMs),
      updatedAt: input.submittedAt,
    })
    .where("publicId", "=", input.publicId)
    .execute();
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
      monitoringEscalatedAt: null,
    });
    expect(body.data.paymentIntent.submittedAt).toEqual(expect.any(String));
    expect(body.data.paymentIntent.monitoringExpiresAt).toEqual(expect.any(String));

    const submittedAt = body.data.paymentIntent.submittedAt;

    const repeatedResponse = await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash });
    expect(repeatedResponse.status).toBe(200);
    expect((repeatedResponse.body as CheckoutBody).data.paymentIntent.submittedAt).toBe(
      submittedAt,
    );
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
            submittedAt: new Date(),
            monitoringExpiresAt: new Date(Date.now() + paymentConfig.droppedMonitoringMs),
            paidAt: new Date(),
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
    await reconcileUnresolvedPaymentIntents();

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
  it("writes a missing transaction and receipt audit event", async () => {
    const hash = `0x${"8".repeat(63)}5`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "1900000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "1900000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "1900000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });
    await reconcilePaidPaymentIntents();

    const event = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(event.actorType).toBe("system");
    expect(event.actorId).toBeNull();
    expect(event.merchantId).toBe("checkout-merchant");
    expect(event.paymentIntentId).toBe(paymentIntent.id);
    expect(event.metadata).toMatchObject({
      transactionHash: hash,
      reason: "missing_transaction_and_receipt",
    });
    const delivery = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .selectAll()
      .where("auditEventId", "=", event.id)
      .executeTakeFirstOrThrow();
    expect(delivery.payload).toEqual({
      version: 1,
      deliveryId: delivery.id,
      eventTime: event.createdAt.toISOString(),
      eventKind: "payment.reorg_detected",
      subject: {
        merchantId: "checkout-merchant",
        paymentIntentId: paymentIntent.id,
        paymentPublicId: paymentIntent.publicId,
        reason: "missing_transaction_and_receipt",
      },
    });
  });

  it("writes a changed receipt identity audit event", async () => {
    const hash = `0x${"8".repeat(63)}6`;
    const otherHash = `0x${"9".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2000000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "2000000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2000000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: otherHash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });
    await reconcilePaidPaymentIntents();

    const event = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(event.merchantId).toBe("checkout-merchant");
    expect(event.metadata).toMatchObject({
      transactionHash: hash,
      reason: "receipt_identity_changed",
    });
  });

  it("writes a reverted receipt audit event", async () => {
    const hash = `0x${"8".repeat(63)}7`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2100000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2100000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "2100000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2100000"),
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

    const event = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(event.metadata).toMatchObject({
      transactionHash: hash,
      reason: "receipt_reverted",
    });
  });

  it("writes a missing transfer log audit event", async () => {
    const hash = `0x${"8".repeat(63)}8`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2200000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2200000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "2200000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2200000"),
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

    const event = await getDb()
      .selectFrom("auditEvents")
      .selectAll()
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(event.metadata).toMatchObject({
      transactionHash: hash,
      reason: "missing_transfer_log",
    });
  });
});

describe("reorg audit concurrency", () => {
  it("creates exactly one audit event for concurrent reorg reconciliation", async () => {
    const hash = `0x${"8".repeat(63)}9`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2300000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2300000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "2300000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    await Promise.all([reconcilePaidPaymentIntents(), reconcilePaidPaymentIntents()]);

    const events = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(Number(events.count)).toBe(1);
    const deliveries = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventKind", "=", "payment.reorg_detected")
      .where("auditEventId", "in", (query) =>
        query
          .selectFrom("auditEvents")
          .select("id")
          .where("paymentIntentId", "=", paymentIntent.id),
      )
      .executeTakeFirstOrThrow();
    expect(Number(deliveries.count)).toBe(1);
  });

  it("rolls back the reorg update when the audit event insertion fails", async () => {
    const hash = `0x${"8".repeat(62)}a0`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "2400000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "2400000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x10",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "2400000")],
        }),
      getCurrentBlockNumber: () => Promise.resolve(0x1b),
    });

    await request(app)
      .post(`/api/payment-links/${paymentIntent.publicId}/transactions`)
      .send({ transactionHash: hash });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/confirm`);

    const subject = await getDb()
      .selectFrom("paymentIntents")
      .select(["id", "merchantId"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();

    await getDb()
      .insertInto("auditEvents")
      .values({
        id: randomUUID(),
        eventType: "payment.reorg_detected",
        actorType: "system",
        actorId: null,
        merchantId: subject.merchantId,
        paymentIntentId: subject.id,
        metadata: {},
      })
      .execute();

    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: () => Promise.resolve(undefined),
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    await reconcilePaidPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select("reorgDetectedAt")
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();

    expect(row.reorgDetectedAt).toBeNull();

    const events = await getDb()
      .selectFrom("auditEvents")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("paymentIntentId", "=", paymentIntent.id)
      .where("eventType", "=", "payment.reorg_detected")
      .executeTakeFirstOrThrow();

    expect(Number(events.count)).toBe(1);
    const deliveries = await getDb()
      .selectFrom("operationalAlertDeliveries")
      .select(({ fn }) => [fn.count("id").as("count")])
      .where("eventKind", "=", "payment.reorg_detected")
      .where("auditEventId", "in", (query) =>
        query
          .selectFrom("auditEvents")
          .select("id")
          .where("paymentIntentId", "=", paymentIntent.id),
      )
      .executeTakeFirstOrThrow();
    expect(Number(deliveries.count)).toBe(0);
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

    const timeoutAgo = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt: timeoutAgo,
    });

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

    const misleadingUpdatedAt = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await getDb()
      .updateTable("paymentIntents")
      .set({ updatedAt: misleadingUpdatedAt })
      .where("publicId", "=", paymentIntent.publicId)
      .execute();

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

    const timeoutAgo = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt: timeoutAgo,
    });

    await reconcileUnresolvedPaymentIntents();

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select("status")
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("dropped");
  });

  it("recovers a dropped payment when the receipt appears after a worker retry", async () => {
    const hash = `0x${"6".repeat(64)}`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "6500000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    let receiptAvailable = false;
    let receiptChecks = 0;
    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "6500000"),
          value: "0x0",
        }),
      getTransactionReceipt: (requestedHash) => {
        if (requestedHash !== hash) return Promise.resolve(undefined);
        receiptChecks += 1;
        return Promise.resolve(
          receiptAvailable
            ? {
                transactionHash: hash,
                blockNumber: "0x50",
                status: "0x1",
                logs: [usdcTransferLog(payerAddress, destinationAddress, "6500000")],
              }
            : undefined,
        );
      },
      getCurrentBlockNumber: () => Promise.resolve(0x5b),
    });

    const timeoutAgo = new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000);
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt: timeoutAgo,
    });

    await reconcileUnresolvedPaymentIntents();
    let row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "transactionHash", "paidAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "dropped", transactionHash: hash, paidAt: null });

    receiptAvailable = true;
    await reconcileUnresolvedPaymentIntents();
    row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "transactionHash", "paidAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("paid");
    expect(row.transactionHash).toBe(hash);
    expect(row.paidAt).not.toBeNull();

    const acceptedAt = row.paidAt;
    await reconcileUnresolvedPaymentIntents();
    const unchanged = await getDb()
      .selectFrom("paymentIntents")
      .select(["paidAt", "transactionHash"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(unchanged).toEqual({ paidAt: acceptedAt, transactionHash: hash });
    expect(receiptChecks).toBe(2);

    const receiptResponse = await request(app).get(
      `/api/payment-links/${paymentIntent.publicId}/receipt`,
    );
    expect(receiptResponse.status).toBe(200);
    expect(receiptResponse.body).toMatchObject({
      success: true,
      data: { receipt: { transactionHash: hash, settlement: "accepted" } },
    });
  });

  it("lets manual reconciliation recover a payment after monitoring is escalated", async () => {
    const hash = `0x${"5".repeat(63)}4`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "6600000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    let receiptAvailable = false;
    setBaseTransactionProvider({
      getTransaction: () =>
        Promise.resolve({
          hash,
          from: payerAddress,
          to: paymentConfig.assetContractAddress,
          input: transferInput(destinationAddress, "6600000"),
          value: "0x0",
        }),
      getTransactionReceipt: () =>
        Promise.resolve(
          receiptAvailable
            ? {
                transactionHash: hash,
                blockNumber: "0x60",
                status: "0x1",
                logs: [usdcTransferLog(payerAddress, destinationAddress, "6600000")],
              }
            : undefined,
        ),
      getCurrentBlockNumber: () => Promise.resolve(0x6b),
    });

    const submittedAt = new Date(Date.now() - paymentConfig.droppedMonitoringMs - 1000);
    const monitoringExpiresAt = new Date(Date.now() - 1000);
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt,
      monitoringExpiresAt,
      status: "dropped",
    });

    await reconcileUnresolvedPaymentIntents();
    const escalated = await request(app).get(`/api/payment-links/${paymentIntent.publicId}`);
    expect(escalated.status).toBe(200);
    const escalatedPayment = (escalated.body as CheckoutBody).data.paymentIntent;
    expect(escalatedPayment.status).toBe("dropped");
    expect(typeof escalatedPayment.monitoringEscalatedAt).toBe("string");

    receiptAvailable = true;
    const recovered = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );
    expect(recovered.status).toBe(200);
    expect((recovered.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "paid",
      transactionHash: hash,
    });
  });

  it("bounds worker retries when the provider keeps failing", async () => {
    const hash = `0x${"5".repeat(63)}a`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "6650000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    const submittedAt = await getDatabaseTime();
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt,
      monitoringExpiresAt: new Date(submittedAt.getTime() + 100),
      status: "dropped",
    });

    let receiptChecks = 0;
    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: (requestedHash) => {
        if (requestedHash === hash) receiptChecks += 1;
        return Promise.reject(new Error("Base RPC unavailable"));
      },
      getCurrentBlockNumber: () => Promise.resolve(0),
    });

    await expect(reconcileCheckout(paymentIntent.publicId, { automated: true })).rejects.toThrow(
      "Base RPC unavailable",
    );
    expect(receiptChecks).toBe(1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    await reconcileCheckout(paymentIntent.publicId, { automated: true });
    expect(receiptChecks).toBe(1);

    const row = await getDb()
      .selectFrom("paymentIntents")
      .select(["status", "monitoringEscalatedAt"])
      .where("publicId", "=", paymentIntent.publicId)
      .executeTakeFirstOrThrow();
    expect(row.status).toBe("dropped");
    expect(row.monitoringEscalatedAt).not.toBeNull();
  });

  it("stops every worker at the deadline without hiding manual recovery", async () => {
    const hash = `0x${"5".repeat(63)}b`;
    const paymentIntent = await createPaymentIntent({
      merchantId: "checkout-merchant",
      amountAtomic: "6660000",
      expiresAt: new Date(Date.now() + 60_000),
    });
    await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

    const submittedAt = new Date(Date.now() - paymentConfig.droppedMonitoringMs - 1000);
    await associatePaymentForTest({
      publicId: paymentIntent.publicId,
      transactionHash: hash,
      submittedAt,
      monitoringExpiresAt: new Date(Date.now() - 1000),
      status: "dropped",
    });

    let receiptChecks = 0;
    setBaseTransactionProvider({
      getTransaction: () => Promise.resolve(undefined),
      getTransactionReceipt: (requestedHash) => {
        if (requestedHash === hash) receiptChecks += 1;
        return Promise.resolve({
          transactionHash: hash,
          blockNumber: "0x80",
          status: "0x1",
          logs: [usdcTransferLog(payerAddress, destinationAddress, "6660000")],
        });
      },
      getCurrentBlockNumber: () => Promise.resolve(0x80),
    });

    await Promise.all([reconcileUnresolvedPaymentIntents(), reconcileUnresolvedPaymentIntents()]);
    expect(receiptChecks).toBe(0);

    const recovered = await request(app).post(
      `/api/payment-links/${paymentIntent.publicId}/confirm`,
    );
    expect(recovered.status).toBe(200);
    expect((recovered.body as CheckoutBody).data.paymentIntent).toMatchObject({
      status: "confirming",
      confirmationCount: 1,
    });
    expect(receiptChecks).toBe(1);

    await reconcileUnresolvedPaymentIntents();
    expect(receiptChecks).toBe(1);
  });

  it.each([
    ["timeout first", "d", "timeout"],
    ["acceptance first", "e", "acceptance"],
  ] as const)(
    "keeps a payment paid when reconciliation races with %s",
    async (_label, hashSuffix, firstWrite) => {
      const hash = `0x${"5".repeat(63)}${hashSuffix}`;
      const paymentIntent = await createPaymentIntent({
        merchantId: "checkout-merchant",
        amountAtomic: "6700000",
        expiresAt: new Date(Date.now() + 60_000),
      });
      await request(app).post(`/api/payment-links/${paymentIntent.publicId}/checkout`);

      let receiptCallCount = 0;
      let releaseMissingReceipt!: (value: undefined) => void;
      let releaseValidReceipt!: (value: {
        transactionHash: string;
        blockNumber: string;
        status: string;
        logs: ReturnType<typeof usdcTransferLog>[];
      }) => void;
      let notifyBothCalls!: () => void;
      const bothCalls = new Promise<void>((resolve) => {
        notifyBothCalls = resolve;
      });
      const missingReceipt = new Promise<undefined>((resolve) => {
        releaseMissingReceipt = resolve;
      });
      const validReceipt = new Promise<{
        transactionHash: string;
        blockNumber: string;
        status: string;
        logs: ReturnType<typeof usdcTransferLog>[];
      }>((resolve) => {
        releaseValidReceipt = resolve;
      });

      setBaseTransactionProvider({
        getTransaction: () =>
          Promise.resolve({
            hash,
            from: payerAddress,
            to: paymentConfig.assetContractAddress,
            input: transferInput(destinationAddress, "6700000"),
            value: "0x0",
          }),
        getTransactionReceipt: () => {
          receiptCallCount += 1;
          if (receiptCallCount === 2) notifyBothCalls();
          return receiptCallCount === 1 ? missingReceipt : validReceipt;
        },
        getCurrentBlockNumber: () => Promise.resolve(0x7b),
      });

      await associatePaymentForTest({
        publicId: paymentIntent.publicId,
        transactionHash: hash,
        submittedAt: new Date(Date.now() - paymentConfig.confirmingTimeoutMs - 1000),
      });

      const timeoutReconciliation = request(app)
        .post(`/api/payment-links/${paymentIntent.publicId}/confirm`)
        .then((response) => response);
      const acceptanceReconciliation = request(app)
        .post(`/api/payment-links/${paymentIntent.publicId}/confirm`)
        .then((response) => response);
      await bothCalls;
      const acceptedReceipt = {
        transactionHash: hash,
        blockNumber: "0x70",
        status: "0x1",
        logs: [usdcTransferLog(payerAddress, destinationAddress, "6700000")],
      };
      if (firstWrite === "timeout") {
        releaseMissingReceipt(undefined);
        expect((await timeoutReconciliation).status).toBe(200);
        releaseValidReceipt(acceptedReceipt);
        expect((await acceptanceReconciliation).status).toBe(200);
      } else {
        releaseValidReceipt(acceptedReceipt);
        expect((await acceptanceReconciliation).status).toBe(200);
        releaseMissingReceipt(undefined);
        expect((await timeoutReconciliation).status).toBe(200);
      }

      const row = await getDb()
        .selectFrom("paymentIntents")
        .select(["status", "transactionHash", "paidAt"])
        .where("publicId", "=", paymentIntent.publicId)
        .executeTakeFirstOrThrow();
      expect(row.status).toBe("paid");
      expect(row.transactionHash).toBe(hash);
      expect(row.paidAt).not.toBeNull();
    },
  );
});
