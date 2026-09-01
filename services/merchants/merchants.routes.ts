import { Router } from "express";

import {
  ipAuthRateLimit,
  ipPublicRateLimit,
  merchantRateLimit,
} from "../../src/middlewares/rate-limit.js";
import {
  cancelPendingWalletChangeController,
  createMerchant,
  createMerchantSession,
  readCurrentMerchant,
  readPendingWalletChange,
  setMerchantWallet,
} from "./merchants.controller.js";
import { requireFreshMerchantSession, requireMerchantSession } from "./merchants.middleware.js";

export const merchantsRouter = Router();

merchantsRouter.post("/merchants", ipAuthRateLimit, createMerchant);
merchantsRouter.post("/merchant-sessions", ipAuthRateLimit, createMerchantSession);
merchantsRouter.get("/merchant-sessions/current", requireMerchantSession, readCurrentMerchant);
merchantsRouter.put(
  "/merchant-wallet",
  ipPublicRateLimit,
  requireFreshMerchantSession,
  merchantRateLimit,
  setMerchantWallet,
);
merchantsRouter.get(
  "/merchant-wallet/pending",
  requireMerchantSession,
  merchantRateLimit,
  readPendingWalletChange,
);
merchantsRouter.delete(
  "/merchant-wallet/pending",
  ipPublicRateLimit,
  requireFreshMerchantSession,
  merchantRateLimit,
  cancelPendingWalletChangeController,
);
