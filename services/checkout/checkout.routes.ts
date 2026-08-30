import { Router } from "express";

import { ipPublicRateLimit, ipRpcRateLimit } from "../../src/middlewares/rate-limit.js";
import { createCheckout, createCheckoutTransaction } from "./checkout.controller.js";
import { reconcileCheckoutTransaction } from "./checkout-reconciliation.controller.js";

export const checkoutRouter = Router();

checkoutRouter.post("/payment-links/:publicId/checkout", ipPublicRateLimit, createCheckout);
checkoutRouter.post(
  "/payment-links/:publicId/transactions",
  ipRpcRateLimit,
  createCheckoutTransaction,
);
checkoutRouter.post(
  "/payment-links/:publicId/confirm",
  ipRpcRateLimit,
  reconcileCheckoutTransaction,
);
