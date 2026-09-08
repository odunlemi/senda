import { randomUUID } from "node:crypto";

import { paymentConfig } from "../../src/config/payment.js";
import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { badRequest } from "../../src/lib/errors.js";
import type { CreatePaymentIntentInput } from "./payment-intents.types.js";
import type { PaymentIntentRow } from "./payment-intents.types.js";

function requirePositiveAtomicAmount(amountAtomic: string): void {
  if (!/^\d+$/.test(amountAtomic) || BigInt(amountAtomic) <= 0n) {
    badRequest("amountAtomic must be a positive integer string");
  }
}

function requireValidExpiry(expiresAt: Date): void {
  if (Number.isNaN(expiresAt.getTime())) {
    badRequest("expiresAt must be a future date");
  }
}

export function toPublicPaymentIntent(row: PaymentIntentRow) {
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
    payerAddress: row.payerAddress,
    transactionHash: row.transactionHash,
    confirmationCount: row.confirmationCount,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    monitoringExpiresAt: row.monitoringExpiresAt?.toISOString() ?? null,
    monitoringEscalatedAt: row.monitoringEscalatedAt?.toISOString() ?? null,
  };
}

export async function createPaymentIntent(input: CreatePaymentIntentInput) {
  requirePositiveAtomicAmount(input.amountAtomic);
  requireValidExpiry(input.expiresAt);

  const row = await getDb()
    .transaction()
    .execute(async (trx) => {
      // Wallet activation also locks the merchant first. Holding this lock
      // through the insert gives creation and activation one database order.
      const merchant = await trx
        .selectFrom("user")
        .select("receivingWalletAddress")
        .where("id", "=", input.merchantId)
        .forUpdate()
        .executeTakeFirst();
      if (!merchant?.receivingWalletAddress) {
        badRequest("Merchant receiving wallet is not configured");
      }

      const now = await getDatabaseTime(trx);
      if (input.expiresAt.getTime() <= now.getTime()) {
        badRequest("expiresAt must be a future date");
      }
      return await trx
        .insertInto("paymentIntents")
        .values({
          id: randomUUID(),
          merchantId: input.merchantId,
          publicId: randomUUID(),
          amountAtomic: input.amountAtomic,
          asset: paymentConfig.asset,
          chain: paymentConfig.chain,
          destinationAddress: merchant.receivingWalletAddress,
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
    });

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
