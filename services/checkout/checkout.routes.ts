import { Router } from "express";

import { createCheckout, createCheckoutTransaction } from "./checkout.controller.js";
import { reconcileCheckoutTransaction } from "./checkout-reconciliation.controller.js";

export const checkoutRouter = Router();

checkoutRouter.post("/payment-links/:publicId/checkout", createCheckout);
checkoutRouter.post("/payment-links/:publicId/transactions", createCheckoutTransaction);
checkoutRouter.post("/payment-links/:publicId/confirm", reconcileCheckoutTransaction);
