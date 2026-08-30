import { Router } from "express";

import { ipPublicRateLimit } from "../../src/middlewares/rate-limit.js";
import { readPaymentReceipt } from "./receipts.controller.js";

export const receiptsRouter = Router();

receiptsRouter.get("/payment-links/:publicId/receipt", ipPublicRateLimit, readPaymentReceipt);
