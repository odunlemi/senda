import { randomUUID } from "node:crypto";

import { paymentConfig } from "../../src/config/payment.js";
import { getDb } from "../../src/lib/db.js";
import type { CreatePaymentIntentInput } from "./payment-intents.types.js";
import type { PaymentIntentRow } from "./payment-intents.types.js";

function requirePositiveAtomicAmount(amountAtomic: string): void {
  if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
    throw new Error("amountAtomic must be a positive integer string");
  }
}

function requireFutureExpiry(expiresAt: Date): void {
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
    throw new Error("expiresAt must be a future date");
  }
}

function toPublicPaymentIntent(row: PaymentIntentRow) {
  return {
    id: row.id,
    publicId: row.publicId,
    amountAtomic: row.amountAtomic,
    asset: row.asset,
    chain: row.chain,
    approvalRequired: paymentConfig.approvalRequired,
    destinationAddress: row.destinationAddress,
    description: row.description,
    reference: row.reference,
    status: row.status,
    expiresAt: row.expiresAt.toISOString(),
  };
}

export async function createPaymentIntent(input: CreatePaymentIntentInput) {
  requirePositiveAtomicAmount(input.amountAtomic);
  requireFutureExpiry(input.expiresAt);

  const now = new Date();
  const row = await getDb()
    .insertInto("paymentIntents")
    .values({
      id: randomUUID(),
      merchantId: input.merchantId,
      publicId: randomUUID(),
      amountAtomic: input.amountAtomic,
      asset: paymentConfig.asset,
      chain: paymentConfig.chain,
      destinationAddress: input.destinationAddress,
      description: input.description ?? null,
      reference: input.reference ?? null,
      status: "created",
      expiresAt: input.expiresAt,
      payerAddress: null,
      transactionHash: null,
      confirmationCount: 0,
      providerEventId: null,
      createdAt: now,
      updatedAt: now,
    })
    .returningAll()
    .executeTakeFirstOrThrow();

  return toPublicPaymentIntent(row);
}

export async function getPublicPaymentIntent(publicId: string) {
  const row = await getDb()
    .selectFrom("paymentIntents")
    .selectAll()
    .where("publicId", "=", publicId)
    .executeTakeFirst();

  return row ? toPublicPaymentIntent(row) : undefined;
}
