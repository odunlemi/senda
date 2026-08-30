import request from "supertest";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { paymentConfig } from "../../src/config/payment.js";
import { getDb } from "../../src/lib/db.js";
import { useTestDatabase } from "../../src/lib/testing.js";

useTestDatabase();

const { createApp } = await import("../../src/app.js");

const app = createApp();

interface ReceiptBody {
  success: boolean;
  data: { receipt: Record<string, unknown> };
}

async function createMerchant(): Promise<string> {
  const id = randomUUID();
  await getDb()
    .insertInto("user")
    .values({
      id,
      name: "Test Merchant",
      email: `${id}@example.com`,
      emailVerified: false,
      image: null,
      receivingWalletAddress: null,
    })
    .execute();
  return id;
}

async function insertPaymentIntent(values: {
  publicId: string;
  status: "paid" | "created";
  paidAt?: Date;
  reorgDetectedAt?: Date | null;
  transactionHash?: string;
  payerAddress?: string;
  confirmationCount?: number;
}): Promise<void> {
  const merchantId = await createMerchant();
  const now = new Date();
  await getDb()
    .insertInto("paymentIntents")
    .values({
      id: randomUUID(),
      merchantId,
      publicId: values.publicId,
      amountAtomic: "1000000",
      asset: paymentConfig.asset,
      chain: paymentConfig.chain,
      destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      description: "Consulting",
      reference: "INV-001",
      status: values.status,
      expiresAt: new Date(Date.now() + 60_000),
      payerAddress: values.payerAddress ?? null,
      transactionHash: values.transactionHash ?? null,
      confirmationCount: values.confirmationCount ?? 0,
      providerEventId: null,
      paidAt: values.paidAt ?? null,
      reorgDetectedAt: values.reorgDetectedAt ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();
}

describe("payment receipts", () => {
  it("returns a complete receipt for a paid payment", async () => {
    const publicId = randomUUID();
    const paidAt = new Date("2026-08-01T12:00:00.000Z");
    await insertPaymentIntent({
      publicId,
      status: "paid",
      paidAt,
      transactionHash: `0x${"a".repeat(64)}`,
      payerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      confirmationCount: 12,
    });

    const response = await request(app).get(`/api/payment-links/${publicId}/receipt`);

    expect(response.status).toBe(200);
    const body = response.body as ReceiptBody;
    expect(body).toMatchObject({
      success: true,
      data: {
        receipt: {
          publicPaymentId: publicId,
          amountAtomic: "1000000",
          asset: "USDC",
          chain: "base",
          description: "Consulting",
          reference: "INV-001",
          payerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          destinationAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          transactionHash: `0x${"a".repeat(64)}`,
          confirmationCount: 12,
          paidAt: paidAt.toISOString(),
          settlement: "accepted",
        },
      },
    });
    expect(body.data.receipt).not.toHaveProperty("merchantId");
    expect(body.data.receipt).not.toHaveProperty("reorgDetectedAt");
  });

  it("returns review_required for a payment that has been reorged", async () => {
    const publicId = randomUUID();
    await insertPaymentIntent({
      publicId,
      status: "paid",
      paidAt: new Date(),
      transactionHash: `0x${"b".repeat(64)}`,
      payerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      confirmationCount: 12,
      reorgDetectedAt: new Date(),
    });

    const response = await request(app).get(`/api/payment-links/${publicId}/receipt`);

    expect(response.status).toBe(200);
    const body = response.body as { data: { receipt: { settlement: string } } };
    expect(body.data.receipt.settlement).toBe("review_required");
  });

  it("returns 404 for an unknown payment link", async () => {
    const response = await request(app).get(`/api/payment-links/${randomUUID()}/receipt`);

    expect(response.status).toBe(404);
    const body = response.body as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("returns 409 for a payment link that is not yet paid", async () => {
    const publicId = randomUUID();
    await insertPaymentIntent({ publicId, status: "created" });

    const response = await request(app).get(`/api/payment-links/${publicId}/receipt`);

    expect(response.status).toBe(409);
    const body = response.body as { success: boolean; error: string };
    expect(body.success).toBe(false);
    expect(typeof body.error).toBe("string");
  });

  it("returns the same receipt on repeated reads", async () => {
    const publicId = randomUUID();
    await insertPaymentIntent({
      publicId,
      status: "paid",
      paidAt: new Date(),
      transactionHash: `0x${"c".repeat(64)}`,
      payerAddress: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      confirmationCount: 12,
    });

    const first = await request(app).get(`/api/payment-links/${publicId}/receipt`);
    const second = await request(app).get(`/api/payment-links/${publicId}/receipt`);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = first.body as ReceiptBody;
    const secondBody = second.body as ReceiptBody;
    expect(firstBody).toEqual(secondBody);
  });
});
