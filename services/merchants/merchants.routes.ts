import { Router } from "express";

import {
  ipAuthRateLimit,
  ipPublicRateLimit,
  merchantRateLimit,
} from "../../src/middlewares/rate-limit.js";
import {
  createMerchant,
  createMerchantSession,
  readCurrentMerchant,
  setMerchantWallet,
} from "./merchants.controller.js";
import { requireMerchantSession } from "./merchants.middleware.js";

export const merchantsRouter = Router();

merchantsRouter.post("/merchants", ipAuthRateLimit, createMerchant);
merchantsRouter.post("/merchant-sessions", ipAuthRateLimit, createMerchantSession);
merchantsRouter.get("/merchant-sessions/current", requireMerchantSession, readCurrentMerchant);
merchantsRouter.put(
  "/merchant-wallet",
  ipPublicRateLimit,
  requireMerchantSession,
  merchantRateLimit,
  setMerchantWallet,
);
