import { Router } from "express";

import { ipPublicRateLimit, merchantRateLimit } from "../../src/middlewares/rate-limit.js";
import { requireMerchantSession } from "../merchants/merchants.middleware.js";
import {
  createMerchantPaymentIntent,
  readPublicPaymentIntent,
} from "./payment-intents.controller.js";

export const paymentIntentsRouter = Router();

paymentIntentsRouter.post(
  "/payment-links",
  ipPublicRateLimit,
  requireMerchantSession,
  merchantRateLimit,
  createMerchantPaymentIntent,
);
paymentIntentsRouter.get("/payment-links/:publicId", ipPublicRateLimit, readPublicPaymentIntent);
