import { randomUUID } from "node:crypto";

import type { PaymentReorgReason } from "../payment-intents/payment-intents.types.js";
import { env } from "../../src/config/env.js";
import { getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import {
  getBaseTransactionProvider,
  type BaseTransaction,
  type BaseTransactionReceipt,
} from "./checkout.provider.js";
import { hasMatchingTransferLog, reconcileCheckout } from "./checkout.service.js";

function classifyReorg(
  transactionHash: string,
  transaction: BaseTransaction | undefined,
  receipt: BaseTransactionReceipt | undefined,
  paymentIntent: { payerAddress: string | null; destinationAddress: string; amountAtomic: string },
): PaymentReorgReason | null {
  if (!transaction && !receipt) return "missing_transaction_and_receipt";
  if (!receipt) return null;
  if (receipt.transactionHash.toLowerCase() !== transactionHash) return "receipt_identity_changed";
  if (receipt.status?.toLowerCase() !== "0x1") return "receipt_reverted";
  if (!hasMatchingTransferLog(receipt, paymentIntent)) return "missing_transfer_log";
  return null;
}

export async function reconcileUnresolvedPaymentIntents(): Promise<void> {
  const intents = await getDb()
    .selectFrom("paymentIntents")
    .select("publicId")
    .where("status", "in", ["confirming", "dropped"])
    .where("monitoringEscalatedAt", "is", null)
    .execute();

  for (const intent of intents) {
    try {
      await reconcileCheckout(intent.publicId, { automated: true });
    } catch (error) {
      logger.error({ err: error, publicId: intent.publicId }, "payment reconciliation failed");
    }
  }
}

export async function reconcilePaidPaymentIntents(): Promise<void> {
  const intents = await getDb()
    .selectFrom("paymentIntents")
    .select([
      "id",
      "merchantId",
      "publicId",
      "transactionHash",
      "payerAddress",
      "destinationAddress",
      "amountAtomic",
    ])
    .where("status", "=", "paid")
    .where("reorgDetectedAt", "is", null)
    .execute();

  const provider = getBaseTransactionProvider();
  for (const intent of intents) {
    if (!intent.transactionHash) continue;

    try {
      const [transaction, receipt] = await Promise.all([
        provider.getTransaction(intent.transactionHash),
        provider.getTransactionReceipt(intent.transactionHash),
      ]);

      const reason = classifyReorg(intent.transactionHash, transaction, receipt, intent);
      if (!reason) continue;

      const updated = await getDb()
        .transaction()
        .execute(async (trx) => {
          const payment = await trx
            .updateTable("paymentIntents")
            .set({ reorgDetectedAt: new Date() })
            .where("publicId", "=", intent.publicId)
            .where("status", "=", "paid")
            .where("reorgDetectedAt", "is", null)
            .returning("publicId")
            .executeTakeFirst();

          if (!payment) return null;

          await trx
            .insertInto("auditEvents")
            .values({
              id: randomUUID(),
              eventType: "payment.reorg_detected",
              actorType: "system",
              actorId: null,
              merchantId: intent.merchantId,
              paymentIntentId: intent.id,
              metadata: { transactionHash: intent.transactionHash, reason },
            })
            .execute();

          return payment;
        });

      if (updated) {
        logger.warn(
          { publicId: intent.publicId, transactionHash: intent.transactionHash, reason },
          "reorg detected on paid payment",
        );
      }
    } catch (error) {
      logger.error({ err: error, publicId: intent.publicId }, "paid reorg check failed");
    }
  }
}

export function startCheckoutReconciliationWorker(): () => void {
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileUnresolvedPaymentIntents();
      await reconcilePaidPaymentIntents();
    } catch (error) {
      logger.error({ err: error }, "payment reconciliation cycle failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => {
    void reconcile();
  }, env.CHECKOUT_RECONCILIATION_INTERVAL_MS);
  timer.unref();
  void reconcile();
  return () => {
    clearInterval(timer);
  };
}
