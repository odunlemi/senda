import { Router } from "express";

import { requireMerchantSession } from "../merchants/merchants.middleware.js";
import {
  createMerchantPaymentIntent,
  readPublicPaymentIntent,
} from "./payment-intents.controller.js";

export const paymentIntentsRouter = Router();

paymentIntentsRouter.post("/payment-links", requireMerchantSession, createMerchantPaymentIntent);
paymentIntentsRouter.get("/payment-links/:publicId", readPublicPaymentIntent);
