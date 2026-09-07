import { getDatabaseTime, getDb } from "../../src/lib/db.js";
import { logger } from "../../src/lib/logger.js";
import { applyWalletChangeRequest } from "./merchants.service.js";

const WORKER_INTERVAL_MS = 15_000;

export async function processDueWalletChanges(
  apply: typeof applyWalletChangeRequest = applyWalletChangeRequest,
): Promise<void> {
  const now = await getDatabaseTime();

  const due = await getDb()
    .selectFrom("walletChangeRequests")
    .select("id")
    .where("status", "=", "pending")
    .where("activationAt", "<=", now)
    .execute();

  for (const request of due) {
    try {
      const result = await apply(request.id);
      if (result.kind === "applied") {
        logger.info({ requestId: request.id }, "wallet change applied");
      } else if (result.kind === "cancelled") {
        logger.info(
          { requestId: request.id, reason: result.reason },
          "wallet change cancelled before activation",
        );
      }
    } catch (error) {
      logger.error({ err: error, requestId: request.id }, "wallet change activation failed");
    }
  }
}

export function startMerchantWalletWorker(): () => void {
  let running = false;

  const run = async () => {
    if (running) return;
    running = true;
    try {
      await processDueWalletChanges();
    } catch (error) {
      logger.error({ err: error }, "wallet change worker cycle failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void run();
  }, WORKER_INTERVAL_MS);
  timer.unref();
  void run();

  return () => {
    clearInterval(timer);
  };
}
