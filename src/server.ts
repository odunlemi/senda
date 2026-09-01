import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { startCheckoutReconciliationWorker } from "../services/checkout/checkout.worker.js";
import { startMerchantWalletWorker } from "../services/merchants/merchants.worker.js";

const app = createApp();
startCheckoutReconciliationWorker();
startMerchantWalletWorker();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "senda listening");
});
