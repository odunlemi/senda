import { env } from "../../src/config/env.js";
import { getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import { reconcileCheckout } from "./checkout.service.js";

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

export function startCheckoutReconciliationWorker(): () => void {
  let running = false;
  const reconcile = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileConfirmingPaymentIntents();
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
