import { env } from "../../src/config/env.js";
import { getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import { getBaseTransactionProvider } from "./checkout.provider.js";
import { hasMatchingTransferLog, reconcileCheckout } from "./checkout.service.js";

export async function reconcileConfirmingPaymentIntents(): Promise<void> {
  const intents = await getDb()
    .selectFrom("paymentIntents")
    .select("publicId")
    .where("status", "=", "confirming")
    .execute();

  for (const intent of intents) {
    try {
      await reconcileCheckout(intent.publicId);
    } catch (error) {
      logger.error({ err: error, publicId: intent.publicId }, "payment reconciliation failed");
    }
  }
}

export async function reconcilePaidPaymentIntents(): Promise<void> {
  const intents = await getDb()
    .selectFrom("paymentIntents")
    .select(["publicId", "transactionHash", "payerAddress", "destinationAddress", "amountAtomic"])
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

      const isReorged =
        (!transaction && !receipt) ||
        (receipt !== undefined &&
          (receipt.transactionHash.toLowerCase() !== intent.transactionHash ||
            receipt.status?.toLowerCase() !== "0x1" ||
            !hasMatchingTransferLog(receipt, intent)));

      if (!isReorged) continue;

      const updated = await getDb()
        .updateTable("paymentIntents")
        .set({ reorgDetectedAt: new Date() })
        .where("publicId", "=", intent.publicId)
        .where("status", "=", "paid")
        .where("reorgDetectedAt", "is", null)
        .returning("publicId")
        .executeTakeFirst();

      if (updated) {
        logger.warn(
          { publicId: intent.publicId, transactionHash: intent.transactionHash },
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
      await reconcileConfirmingPaymentIntents();
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
