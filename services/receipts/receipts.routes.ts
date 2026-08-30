import { Router } from "express";

import { readPaymentReceipt } from "./receipts.controller.js";

export const receiptsRouter = Router();

receiptsRouter.get("/payment-links/:publicId/receipt", readPaymentReceipt);
